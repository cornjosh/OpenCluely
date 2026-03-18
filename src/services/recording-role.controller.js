const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const logger = require('../core/logger').createServiceLogger('ROLE_SWITCH');

class RecordingRoleController extends EventEmitter {
  constructor({
    defaultRole = 'interviewer',
    alternateRole = 'interviewee',
    shortcut = 'CommandOrControl+B',
    persistPath = null
  } = {}) {
    super();
    this.defaultRole = defaultRole;
    this.alternateRole = alternateRole;
    this.shortcut = shortcut;
    this.persistPath = persistPath;
    this.currentRole = defaultRole;
    this.isShortcutPressed = false;
    this.roleSegments = [];
    this.lastRoleChangeAt = Date.now();
  }

  getCurrentRole() {
    return this.currentRole;
  }

  getRoleSegments() {
    return [...this.roleSegments];
  }

  detectShortcutConflict(shortcuts = []) {
    const normalizedTarget = String(this.shortcut || '').toLowerCase();
    return shortcuts.some((shortcut) => String(shortcut || '').toLowerCase() === normalizedTarget);
  }

  handleShortcutPress(source = 'keyboard') {
    if (this.isShortcutPressed) {
      return false;
    }

    this.isShortcutPressed = true;
    this.switchRole(this.alternateRole, 'press', source);
    return true;
  }

  handleShortcutRelease(source = 'keyboard') {
    if (!this.isShortcutPressed) {
      return false;
    }

    this.isShortcutPressed = false;
    this.switchRole(this.defaultRole, 'release', source);
    return true;
  }

  switchRole(nextRole, action, source) {
    if (nextRole === this.currentRole) {
      return;
    }

    const now = Date.now();
    const segment = {
      role: this.currentRole,
      startedAt: this.lastRoleChangeAt,
      endedAt: now
    };
    this.roleSegments.push(segment);

    this.currentRole = nextRole;
    this.lastRoleChangeAt = now;

    const payload = {
      role: this.currentRole,
      action,
      source,
      timestamp: now
    };

    logger.info('Recording role switched', {
      action: 'role_switch',
      role: this.currentRole,
      source,
      operation: action
    });

    this.emit('role-changed', payload);
  }

  markAudioChunk(chunk, metadata = {}) {
    return {
      chunk,
      role: this.currentRole,
      timestamp: metadata.timestamp || Date.now()
    };
  }

  attachBrowserListeners(targetWindow = global.window) {
    if (!targetWindow || typeof targetWindow.addEventListener !== 'function') {
      return () => {};
    }

    const shortcut = String(this.shortcut || 'CommandOrControl+B').toLowerCase();
    const targetKey = shortcut.split('+').pop();
    const needsPrimaryModifier = shortcut.includes('commandorcontrol');

    const onKeyDown = (event) => {
      const key = String(event.key || '').toLowerCase();
      const hasPrimaryModifier = needsPrimaryModifier ? (event.ctrlKey || event.metaKey) : true;
      if (key === targetKey && hasPrimaryModifier) {
        this.handleShortcutPress('browser');
      }
    };

    const onKeyUp = (event) => {
      const key = String(event.key || '').toLowerCase();
      const hasPrimaryModifier = needsPrimaryModifier ? (event.ctrlKey || event.metaKey) : true;
      if (key === targetKey && hasPrimaryModifier) {
        this.handleShortcutRelease('browser');
      }
    };

    targetWindow.addEventListener('keydown', onKeyDown);
    targetWindow.addEventListener('keyup', onKeyUp);
    targetWindow.addEventListener('beforeunload', () => {
      try {
        this.persistSegments();
      } catch (error) {
        logger.warn('Failed to persist role segments during beforeunload', {
          action: 'role_persist',
          role: this.currentRole,
          error: error.message
        });
      }
    });
    return () => {
      targetWindow.removeEventListener('keydown', onKeyDown);
      targetWindow.removeEventListener('keyup', onKeyUp);
    };
  }

  finalizeSegments() {
    this.roleSegments.push({
      role: this.currentRole,
      startedAt: this.lastRoleChangeAt,
      endedAt: Date.now()
    });
    return this.getRoleSegments();
  }

  persistSegments() {
    if (!this.persistPath) {
      return;
    }

    const absolutePath = path.resolve(this.persistPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify(this.finalizeSegments(), null, 2), 'utf8');
  }
}

module.exports = {
  RecordingRoleController
};
