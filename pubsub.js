'use strict'

const UpRing = require('upring')
const mqemitter = require('mqemitter')
const eos = require('end-of-stream')
const counter = require('./lib/counter')
const Receiver = require('./lib/receiver')
const hyperid = require('hyperid')()
const ns = 'pubsub'
const untrack = Symbol('untrack')
const upwrap = Symbol('upwrap')

function UpRingPubSub (opts) {
  if (!(this instanceof UpRingPubSub)) {
    return new UpRingPubSub(opts)
  }

  this.upring = new UpRing(opts)
  this._internal = mqemitter(opts)

  this._receivers = new Map()

  this._ready = false
  this.closed = false

  // Add command
  this.upring.add({
    ns,
    cmd: 'publish'
  }, (req, reply) => {
    if (this.closed) {
      reply(new Error('instance closing'))
      return
    }

    this.logger.debug(req, 'emitting')
    this._internal.emit(req.msg, reply)
  })

  // expose the parent logger
  this.logger = this.upring.logger

  const count = counter()

  var lastTick = 0
  var currTick = counter.max

  const tick = function () {
    currTick = count()
  }

  // Subscribe command
  this.upring.add({
    ns,
    cmd: 'subscribe'
  }, (req, reply) => {
    const stream = req.streams && req.streams.messages
    const logger = this.logger.child({
      incomingSubscription: {
        topic: req.topic,
        key: req.key,
        id: hyperid()
      }
    })

    if (!stream) {
      return reply(new Error('missing messages stream'))
    }

    if (this.closed) {
      stream.destroy()
      return reply(new Error('closing'))
    }

    const upring = this.upring

    // the listener that we will pass to MQEmitter
    function listener (data, cb) {
      if (lastTick === currTick) {
        logger.debug(data, 'duplicate data')
        // this is a duplicate
        cb()
      } else if (!upring.allocatedToMe(extractBase(data.topic))) {
        // nothing to do, we are not responsible for this
        logger.debug(data, 'not allocated here')
        cb()
      } else {
        logger.debug(data, 'writing data')
        stream.write(data, cb)
        // magically detect duplicates, as they will be emitted
        // in the same JS tick
        lastTick = currTick
        process.nextTick(tick)
      }
    }

    var tracker

    logger.info('subscribe')

    if (req.key) {
      if (this.upring.allocatedToMe(req.key)) {
        // close if the responsible peer changes
        // and trigger the reconnection mechanism on
        // the other side
        tracker = this.upring.track(req.key)
        tracker.on('move', () => {
          logger.info('moving subscription to new peer')
          this._internal.removeListener(req.topic, listener)
          if (stream.destroy) {
            stream.destroy()
          } else {
            stream.end()
          }
        })
      } else {
        logger.warn('unable to subscribe, not allocated here')
        this._internal.removeListener(req.topic, listener)
        if (stream.destroy) {
          stream.destroy()
        } else {
          stream.end()
        }
      }
    }

    // remove the subscription when the stream closes
    eos(stream, () => {
      logger.info('stream closed')
      if (tracker) {
        tracker.end()
      }
      this._internal.removeListener(req.topic, listener)
    })

    this._internal.on(req.topic, listener, () => {
      // confirm the subscription
      reply()
    })
  })

  this.upring.on('up', () => {
    this._ready = true
  })

  this.upring.on('peerUp', (peer) => {
    // TODO maybe we should keep track of the wildcard
    // receivers in a list, and walk through there
    for (let receiver in this._receivers) {
      if (receiver.peers) {
        receiver.peers.push(peer)
        receiver.sendPeer(peer, 0, noop)
      }
    }
  })
}

UpRingPubSub.prototype.whoami = function () {
  return this.upring.whoami()
}

// Extract the base topic if there is a wildcard
function extractBase (topic) {
  const levels = topic.split('/')

  if (levels.length < 2) {
    return topic
  } else if (levels[1] === '#') {
    return levels[0]
  } else {
    return levels[0] + '/' + levels[1]
  }
}

// do we have a wildcard?
function hasLowWildCard (topic) {
  const levels = topic.split('/')

  return levels[0] === '#' || levels[1] === '#' ||
         levels[0] === '+' || levels[1] === '+'
}

Object.defineProperty(UpRingPubSub.prototype, 'current', {
  get: function () {
    return this._internal.current
  }
})

UpRingPubSub.prototype.emit = function (msg, cb) {
  if (!this._ready) {
    this.upring.once('up', this.emit.bind(this, msg, cb))
    return
  }

  const key = extractBase(msg.topic)
  const data = {
    cmd: 'publish',
    ns,
    key,
    msg
  }

  this.logger.debug(data, 'sending request')
  this.upring.request(data, cb || noop)
}

UpRingPubSub.prototype.on = function (topic, onMessage, done) {
  if (!this._ready) {
    this.upring.once('up', this.on.bind(this, topic, onMessage, done))
    return
  }

  done = done || noop

  const key = extractBase(topic)
  if (!onMessage[upwrap]) {
    onMessage[upwrap] = (msg, cb) => {
      onMessage.call(this, msg, cb)
    }
  }

  this._internal.on(topic, onMessage[upwrap])

  let peers = null

  // data is already flowing through this instance
  // nothing to do
  if (this._receivers.has(topic)) {
    this.logger.info({ topic }, 'subscription already setup')
    this._receivers.get(topic).count++
    process.nextTick(done)
    return
  } else if (hasLowWildCard(topic)) {
    peers = this.upring.peers(false)
  } else if (this.upring.allocatedToMe(key)) {
    this.logger.info({ topic }, 'local subscription')

    onMessage[untrack] = this.upring.track(key).on('move', () => {
      // resubscribe if it is moved to someone else
      onMessage[untrack] = undefined
      setImmediate(() => {
        this.removeListener(topic, onMessage, () => {
          this.on(topic, onMessage, () => {
            this.logger.info({ topic }, 'resubscribed because topic moved to another peer')
          })
        })
      })
    })

    process.nextTick(done)

    return this
  }

  // normal case, we just need to go to a single instance
  const receiver = new Receiver(this, topic, key, peers)
  this._receivers.set(topic, receiver)
  receiver.send(done)

  return this
}

UpRingPubSub.prototype.removeListener = function (topic, onMessage, done) {
  const receiver = this._receivers.get(topic)

  if (onMessage[untrack]) {
    onMessage[untrack].end()
    onMessage[untrack] = undefined
  }

  if (receiver && --receiver.count === 0) {
    receiver.unsubscribe()
  }

  this._internal.removeListener(topic, onMessage[upwrap], done)
}

UpRingPubSub.prototype.close = function (cb) {
  cb = cb || noop
  if (!this._ready) {
    this.upring.once('up', this.close.bind(this, cb))
    return
  }

  if (this.closed) {
    cb()
    return
  }

  this._receivers.forEach((value, key) => {
    value.unsubscribe()
  })

  this.closed = true

  this._internal.close(() => {
    this.upring.close((err) => {
      cb(err)
    })
  })
}

function noop () {}

module.exports = UpRingPubSub
