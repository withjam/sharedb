var emitter = require('../../emitter');
var LocalPresence = require('./local-presence');
var RemotePresence = require('./remote-presence');
var util = require('../../util');
var async = require('async');

module.exports = Presence;
function Presence(connection, channel) {
  emitter.EventEmitter.call(this);

  if (!channel || typeof channel !== 'string') {
    throw new Error('Presence channel must be provided');
  }

  this.connection = connection;
  this.channel = channel;

  this.wantSubscribe = false;
  this.subscribed = false;
  this.remotePresences = {};
  this.localPresences = {};
  this.seq = 1;

  this._remotePresenceInstances = {};
  this._subscriptionCallbacksBySeq = {};
}
emitter.mixin(Presence);

Presence.prototype.subscribe = function(callback) {
  this._sendSubscriptionAction(true, callback);
};

Presence.prototype.unsubscribe = function(callback) {
  this._sendSubscriptionAction(false, callback);
};

Presence.prototype.create = function(id) {
  var localPresence = this._createLocalPresence(id);
  this.localPresences[id] = localPresence;
  return localPresence;
};

Presence.prototype.destroy = function(callback) {
  this.unsubscribe(function(error) {
    if (error) return this._callbackOrEmit(error, callback);
    var localIds = Object.keys(this.localPresences);
    var remoteIds = Object.keys(this._remotePresenceInstances);
    async.parallel(
      [
        function(next) {
          async.each(localIds, function(presenceId, next) {
            this.localPresences[presenceId].destroy(next);
          }.bind(this), next);
        }.bind(this),
        function(next) {
          async.each(remoteIds, function(presenceId, next) {
            this._remotePresenceInstances[presenceId].destroy(next);
          }.bind(this), next);
        }.bind(this)
      ],
      function(error) {
        delete this.connection._presences[this.channel];
        this._callbackOrEmit(error, callback);
      }.bind(this)
    );
  }.bind(this));
};

Presence.prototype._sendSubscriptionAction = function(wantSubscribe, callback) {
  this.wantSubscribe = !!wantSubscribe;
  var action = this.wantSubscribe ? 'ps' : 'pu';
  var seq = this.seq++;
  this._subscriptionCallbacksBySeq[seq] = callback;
  if (this.connection.canSend) {
    this.connection._sendPresenceAction(action, seq, this);
  }
};

Presence.prototype._handleSubscribe = function(error, seq) {
  if (this.wantSubscribe) this.subscribed = true;
  var callback = this._subscriptionCallback(seq);
  this._callbackOrEmit(error, callback);
};

Presence.prototype._handleUnsubscribe = function(error, seq) {
  this.subscribed = false;
  var callback = this._subscriptionCallback(seq);
  this._callbackOrEmit(error, callback);
};

Presence.prototype._receiveUpdate = function(error, message) {
  var localPresence = util.dig(this.localPresences, message.id);
  if (localPresence) return localPresence._ack(error, message.seq);

  if (error) return this.emit('error', error);
  var remotePresence = util.digOrCreate(this._remotePresenceInstances, message.id, function() {
    return this._createRemotePresence(message.id);
  }.bind(this));

  remotePresence.receiveUpdate(message);
};

Presence.prototype._updateRemotePresence = function(remotePresence) {
  this.remotePresences[remotePresence.presenceId] = remotePresence.value;
  if (remotePresence.value === null) this._removeRemotePresence(remotePresence.presenceId);
  this.emit('receive', remotePresence.presenceId, remotePresence.value);
};

Presence.prototype._broadcastAllLocalPresence = function(error) {
  if (error) return this.emit('error', error);
  for (var id in this.localPresences) {
    var localPresence = this.localPresences[id];
    if (localPresence.value !== null) localPresence.send();
  }
};

Presence.prototype._removeRemotePresence = function(id) {
  this._remotePresenceInstances[id].destroy();
  delete this._remotePresenceInstances[id];
  delete this.remotePresences[id];
};

Presence.prototype._onConnectionStateChanged = function() {
  if (!this.connection.canSend) return;
  this._resubscribe();
  for (var id in this.localPresences) {
    this.localPresences[id]._sendPending();
  }
};

Presence.prototype._resubscribe = function() {
  var callbacks = [];
  for (var seq in this._subscriptionCallbacksBySeq) {
    var callback = this._subscriptionCallback(seq);
    callbacks.push(callback);
  }

  if (!this.wantSubscribe) return this._callEachOrEmit(null, callbacks);

  this.subscribe(function(error) {
    this._callEachOrEmit(error, callbacks);
  }.bind(this));
};

Presence.prototype._subscriptionCallback = function(seq) {
  var callback = this._subscriptionCallbacksBySeq[seq];
  delete this._subscriptionCallbacksBySeq[seq];
  return callback;
};

Presence.prototype._callbackOrEmit = function(error, callback) {
  if (callback) return process.nextTick(callback, error);
  if (error) this.emit('error', error);
};

Presence.prototype._createLocalPresence = function(id) {
  return new LocalPresence(this, id);
};

Presence.prototype._createRemotePresence = function(id) {
  return new RemotePresence(this, id);
};

Presence.prototype._callEachOrEmit = function(error, callbacks) {
  if (callbacks && callbacks.length) {
    return callbacks.forEach(function(callback) {
      process.nextTick(callback, error);
    });
  }

  if (error) this.emit('error', error);
};