'use strict'

const UpRing = require('upring')
const inherits = require('util').inherits
const mqemitter = require('mqemitter')
const streams = require('readable-stream')
const Writable = streams.Writable
const ns = 'pubsub'

function UpRingPubSub (opts) {
  if (!(this instanceof UpRingPubSub)) {
    return new UpRingPubSub(opts)
  }

  this.upring = new UpRing(opts)
  this._internal = mqemitter(opts)

  this._streams = new Map()

  this._ready = false

  this.upring.add({
    ns,
    cmd: 'publish'
  }, (req, reply) => {
    this._internal.emit(req.msg, reply)
  })

  this.upring.add({
    ns,
    cmd: 'subscribe'
  }, (req, reply) => {
    const stream = req.streams && req.streams.messages

    if (!stream) {
      return reply(new Error('missing messages stream'))
    }

    // TODO add deduplication counters
    function listener (data, cb) {
      stream.write(data, cb)
    }

    // TODO handle stream closing
    this._internal.on(req.topic, listener, reply)
  })

  this.upring.on('up', () => {
    this._ready = true
  })
}

UpRingPubSub.prototype.whoami = function () {
  return this.upring.whoami()
}

function extractBase (topic) {
  const levels = topic.split('/')

  if (levels.length < 2) {
    return topic
  } else {
    return levels[0] + '/' + levels[1]
  }
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
  this.upring.request({
    cmd: 'publish',
    ns,
    key,
    msg
  }, cb)
}

function Receiver (mq) {
  this._mq = mq
  Writable.call(this, {
    objectMode: true
  })
}

inherits(Receiver, Writable)

// TODO implement writev
Receiver.prototype._write = function (chunk, enc, cb) {
  // TODO implement deduplication
  this._mq.emit(chunk, cb)
}

UpRingPubSub.prototype.on = function (topic, onMessage, done) {
  if (!this._ready) {
    this.upring.once('up', this.on.bind(this, topic, onMessage, done))
    return
  }

  const key = extractBase(topic)
  if (!onMessage.__upWrap) {
    onMessage.__upWrap = (msg, cb) => {
      onMessage.call(this, msg, cb)
    }
  }

  this._internal.on(topic, onMessage.__upWrap, done)

  if (this._streams.has(topic) || this.upring.allocatedToMe(key)) {
    // data is already flowing through this instance
    // nothing to do
    done()
    return
  }

  const receiver = new Receiver(this._internal)
  this._streams.set(topic, receiver)

  this.upring.request({
    cmd: 'subscribe',
    ns,
    key,
    topic,
    streams: {
      messages: receiver
    }
  }, (err, res) => {
    if (err) {
      return done(err)
    }

    // TODO handle streams getting closed
    const source = res.streams.messages
    source.pipe(receiver)
    done()
  })
}

UpRingPubSub.prototype.removeListener = function (topic, onMessage, done) {
}

UpRingPubSub.prototype.close = function (cb) {
  cb = cb || noop
  if (!this._ready) {
    this.upring.once('up', this.close.bind(this, cb))
    return
  }
  this._internal.close()
  this.upring.close(cb)
}

function noop () {}

module.exports = UpRingPubSub
