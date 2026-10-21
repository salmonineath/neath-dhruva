/*
* Dhruva GNOME Extension
* Copyright (C) 2026 NarkAgni
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program. If not, see <https://www.gnu.org/licenses/>.
*/


import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Settings } from '../../core/SettingsManager.js';
import { CRTMinimize, CRTRestore } from './CrtEffect.js';
import { TimeoutTracker } from '../../core/TimeoutTracker.js';
import { SnakeMinimize, SnakeRestore } from './SnakeEffect.js';
import { JellyMinimize, JellyRestore } from './JellyEffect.js';
import { VortexMinimize, VortexRestore } from './VortexEffect.js';
import { OrigamiMinimize, OrigamiRestore } from './OrigamiEffect.js';
import { isActorAlive, captureActorRect } from '../../core/Utils.js';
import { MagicLampMinimize, MagicLampRestore } from './GenieEffect.js';


const MIN_EFFECT_NAME = 'we-minimize-effect';
const UNMIN_EFFECT_NAME = 'we-unminimize-effect';
const DEFAULT_EFFECT_DURATION_MS = 350;

let _pendingActor = null;
let _pendingIcon = null;
let _pendingDockPos = null;
let _pendingLaunchActor = null;
let _settings = null;
let _dockUI = null;
const _docks = [];
const WM_SIGNAL_OWNER = {};

const _animatingActors = [];
let _effectTimers = null;
let _effectIdleId = 0;

let _origShouldAnimate = null;
let _origCompletedMinimize = null;
let _origCompletedUnminimize = null;
let _origCompletedMap = null;

function _getEffectDuration() {
    const val = Settings.windowEffectSpeed;
    return (Number.isFinite(val) && val >= 50) ? val : DEFAULT_EFFECT_DURATION_MS;
}

function _addAnimatingActor(actor) {
    if (!_animatingActors.includes(actor)) {
        _animatingActors.push(actor);
    }
}

function _removeAnimatingActor(actor) {
    const idx = _animatingActors.indexOf(actor);
    if (idx !== -1) _animatingActors.splice(idx, 1);
}

function _addEffectIdle(cb) {
    if (_effectTimers) {
        if (_effectIdleId) {
            _effectTimers.remove(_effectIdleId);
            _effectIdleId = 0;
        }
        _effectIdleId = _effectTimers.addIdle(GLib.PRIORITY_DEFAULT, () => {
            _effectIdleId = 0;
            cb();
            return GLib.SOURCE_REMOVE;
        });
    }
}

function _clearEffectIdles() {
    if (_effectIdleId && _effectTimers) {
        _effectTimers.remove(_effectIdleId);
        _effectIdleId = 0;
    }
    if (_effectTimers) {
        _effectTimers.destroy();
        _effectTimers = null;
    }
}

function _applyEffectDuration(effect, duration) {
    if (!effect) return null;
    effect._duration = duration;
    effect.duration = duration;
    if (effect.setDuration) effect.setDuration(duration);
    return effect;
}

function _makeMinimize(iconPos, dockPos, type) {
    const duration = _getEffectDuration();
    let effect;
    switch (type) {
        case 'magic-lamp': effect = new MagicLampMinimize(iconPos, dockPos); break;
        case 'snake': effect = new SnakeMinimize(iconPos, dockPos); break;
        case 'vortex': effect = new VortexMinimize(iconPos, dockPos); break;
        case 'crt': effect = new CRTMinimize(iconPos, dockPos); break;
        case 'origami': effect = new OrigamiMinimize(iconPos, dockPos); break;
        case 'jelly': effect = new JellyMinimize(iconPos, dockPos); break;
        default: effect = new MagicLampMinimize(iconPos, dockPos); break;
    }
    return _applyEffectDuration(effect, duration);
}

function _makeRestore(iconPos, dockPos, type) {
    const duration = _getEffectDuration();
    let effect;
    switch (type) {
        case 'magic-lamp': effect = new MagicLampRestore(iconPos, dockPos); break;
        case 'snake': effect = new SnakeRestore(iconPos, dockPos); break;
        case 'vortex': effect = new VortexRestore(iconPos, dockPos); break;
        case 'crt': effect = new CRTRestore(iconPos, dockPos); break;
        case 'origami': effect = new OrigamiRestore(iconPos, dockPos); break;
        case 'jelly': effect = new JellyRestore(iconPos, dockPos); break;
        default: effect = new MagicLampRestore(iconPos, dockPos); break;
    }
    return _applyEffectDuration(effect, duration);
}

// GNOME's own minimize/unminimize/map handler always runs before ours. When it
// is not animating the actor, it has already called completed_*() itself, so we
// must neither animate nor complete that actor again.
function _gnomeIsAnimating(setName, actor) {
    const set = Main.wm ? Main.wm[setName] : null;
    return Boolean(set && set.has(actor));
}

// Only a pending actor (minimize/restore clicked in Dhruva) had its GNOME
// completion swallowed by our completed_*() patch, so only then do we owe it.
function _completeIfOwned(actor, origCompleted) {
    if (actor !== _pendingActor) return;
    _pendingActor = _pendingIcon = _pendingDockPos = null;
    if (origCompleted && isActorAlive(actor)) origCompleted.call(Main.wm._shellwm, actor);
}

function _isAppButton(btn, app) {
    const delegate = btn._delegate;
    return Boolean(delegate && delegate.app && 'get_id' in delegate.app && delegate.app.get_id() === app.get_id());
}

function _dockButtons() {
    return _dockUI && _dockUI.boxActor ? _dockUI.boxActor.get_children() : [];
}

function _findDockButton(win) {
    const app = win && Shell.WindowTracker.get_default().get_window_app(win);
    return app ? _dockButtons().find(btn => _isAppButton(btn, app)) : null;
}

function _pendingTarget(actor) {
    if (actor !== _pendingActor || !_pendingIcon) return null;
    const target = { iconPos: _pendingIcon, dockPos: _pendingDockPos };
    _addEffectIdle(() => {
        if (_pendingActor === actor) _pendingActor = _pendingIcon = _pendingDockPos = null;
    });
    return target;
}

// Take over only an animation GNOME is still running (it then hands the
// completion to us); never re-animate a window GNOME already completed.
function _takeoverTarget(actor, gnomeSet) {
    if (actor !== _pendingActor && !_gnomeIsAnimating(gnomeSet, actor)) return null;
    const btn = _findDockButton(actor.meta_window);
    return btn ? { iconPos: captureActorRect(btn, actor.meta_window), dockPos: _dockUI.dockPosition } : null;
}

function _finishRunningEffects() {
    for (const actor of [..._animatingActors].filter(isActorAlive)) {
        [MIN_EFFECT_NAME, UNMIN_EFFECT_NAME]
            .map(name => actor.get_effect(name))
            .filter(Boolean)
            .forEach(effect => effect.destroy());
    }
}

function _patchWm() {
    if (_origShouldAnimate) return;
    if (!Main.wm || !Main.wm._shellwm || !Main.wm._shouldAnimateActor) return;

    _origShouldAnimate = Main.wm._shouldAnimateActor;
    Main.wm._shouldAnimateActor = function (actor, types) {
        if (actor === _pendingActor || actor === _pendingLaunchActor || _animatingActors.includes(actor)) return false;

        const pendingLaunches = _docks.flatMap(dock => dock._pendingLaunches || []);
        if (actor.meta_window && pendingLaunches.length > 0) {
            const tracker = Shell.WindowTracker.get_default();
            const winApp = tracker.get_window_app(actor.meta_window);
            const winClass = actor.meta_window.get_wm_class() ? actor.meta_window.get_wm_class().toLowerCase() : '';

            const isPending = pendingLaunches.some(p => {
                if (p.consumed) return false;
                if (p.appId && winApp && winApp.get_id() === p.appId) return true;
                if (p.appId && winClass) {
                    const appBase = p.appId.toLowerCase().replace('.desktop', '');
                    if (appBase.includes(winClass) || winClass.includes(appBase)) return true;
                }
                if (p.isFolder && (winClass.includes('nautilus') || winClass.includes('files'))) return true;
                return false;
            });

            if (isPending) return false;
        }

        return _origShouldAnimate.call(this, actor, types);
    };

    const shellwm = Main.wm._shellwm;

    _origCompletedMinimize = shellwm.completed_minimize;
    shellwm.completed_minimize = function (actor) {
        if (actor === _pendingActor || _animatingActors.includes(actor)) return;
        _origCompletedMinimize.call(this, actor);
    };

    _origCompletedUnminimize = shellwm.completed_unminimize;
    shellwm.completed_unminimize = function (actor) {
        if (actor === _pendingActor || _animatingActors.includes(actor)) return;
        _origCompletedUnminimize.call(this, actor);
    };

    _origCompletedMap = shellwm.completed_map;
    shellwm.completed_map = function (actor) {
        if (_animatingActors.includes(actor)) return;
        _origCompletedMap.call(this, actor);
    };
}

function _unpatchWm() {
    if (_origShouldAnimate) {
        if (Main.wm) Main.wm._shouldAnimateActor = _origShouldAnimate;
        if (Main.wm && Main.wm._shellwm) {
            Main.wm._shellwm.completed_minimize = _origCompletedMinimize;
            Main.wm._shellwm.completed_unminimize = _origCompletedUnminimize;
            if (_origCompletedMap) Main.wm._shellwm.completed_map = _origCompletedMap;
        }

        _origShouldAnimate = null;
        _origCompletedMinimize = null;
        _origCompletedUnminimize = null;
        _origCompletedMap = null;
    }
}

export function finishMinimizeEffect(actor) {
    _removeAnimatingActor(actor);
    if (isActorAlive(actor) && _origCompletedMinimize && Main.wm && Main.wm._shellwm) {
        _origCompletedMinimize.call(Main.wm._shellwm, actor);
    }
}

export function finishRestoreEffect(actor) {
    _removeAnimatingActor(actor);
    if (isActorAlive(actor)) {
        if (actor._isDhruvaLaunching) {
            // GNOME already completed the map when we suppressed its animation.
            actor._isDhruvaLaunching = false;
        } else if (_origCompletedUnminimize && Main.wm && Main.wm._shellwm) {
            _origCompletedUnminimize.call(Main.wm._shellwm, actor);
        }
    }
}

export function setupWindowEffects(settings, dockUI) {
    if (!_docks.includes(dockUI)) {
        _docks.push(dockUI);
    }
    if (_docks.length > 1) return;

    _settings = settings;
    _dockUI = dockUI;

    if (!_effectTimers) {
        _effectTimers = new TimeoutTracker();
    }

    _patchWm();

    global.window_manager.connectObject(
        'minimize', (_wm, actor) => {
            const type = (_settings && Settings.minimizeEffect) || 'magic-lamp';

            if (actor === _pendingActor && global._dhruvaIsFade) {
                global._dhruvaIsFade = false;

                const capturedActor = _pendingActor;
                _addEffectIdle(() => {
                    if (_pendingActor === capturedActor) _pendingActor = null;
                });

                _addAnimatingActor(actor);
                if (actor.remove_all_transitions) actor.remove_all_transitions();

                const fadeDuration = Math.max(120, Math.round(_getEffectDuration() * 0.5));
                actor.set_pivot_point(0.5, 0.5);
                actor.ease({
                    opacity: 0,
                    scale_x: 0.95,
                    scale_y: 0.95,
                    duration: fadeDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        _removeAnimatingActor(actor);
                        if (isActorAlive(actor)) {
                            actor.set_pivot_point(0, 0);
                            actor.set_scale(1.0, 1.0);
                            actor.opacity = 255;
                            actor.hide();
                            if (_origCompletedMinimize && Main.wm && Main.wm._shellwm) {
                                _origCompletedMinimize.call(Main.wm._shellwm, actor);
                            }
                        }
                    }
                });
                return;
            }

            if (type === 'none') {
                _completeIfOwned(actor, _origCompletedMinimize);
                return;
            }

            const target = _pendingTarget(actor) || _takeoverTarget(actor, '_minimizing');
            if (!target) {
                _completeIfOwned(actor, _origCompletedMinimize);
                return;
            }

            _addAnimatingActor(actor);
            if (actor.remove_all_transitions) actor.remove_all_transitions();

            const old = actor.get_effect(MIN_EFFECT_NAME);
            if (old) actor.remove_effect(old);

            actor.add_effect_with_name(MIN_EFFECT_NAME, _makeMinimize(target.iconPos, target.dockPos, type));
        },
        'unminimize', (_wm, actor) => {
            const type = (_settings && Settings.minimizeEffect) || 'magic-lamp';

            if (actor === _pendingActor && global._dhruvaIsFade) {
                global._dhruvaIsFade = false;

                const capturedActor = _pendingActor;
                _addEffectIdle(() => {
                    if (_pendingActor === capturedActor) _pendingActor = null;
                });

                _addAnimatingActor(actor);
                if (actor.remove_all_transitions) actor.remove_all_transitions();

                const fadeDuration = Math.max(120, Math.round(_getEffectDuration() * 0.5));
                actor.show();
                actor.opacity = 0;
                actor.set_pivot_point(0.5, 0.5);
                actor.set_scale(0.95, 0.95);

                actor.ease({
                    opacity: 255,
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: fadeDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        _removeAnimatingActor(actor);
                        if (isActorAlive(actor)) {
                            actor.set_pivot_point(0, 0);
                            actor.set_scale(1.0, 1.0);
                            actor.opacity = 255;
                            if (_origCompletedUnminimize && Main.wm && Main.wm._shellwm) {
                                _origCompletedUnminimize.call(Main.wm._shellwm, actor);
                            }
                        }
                    }
                });
                return;
            }

            if (type === 'none') {
                _completeIfOwned(actor, _origCompletedUnminimize);
                return;
            }

            const target = _pendingTarget(actor) || _takeoverTarget(actor, '_unminimizing');
            if (!target) {
                _completeIfOwned(actor, _origCompletedUnminimize);
                return;
            }

            _addAnimatingActor(actor);
            if (actor.remove_all_transitions) actor.remove_all_transitions();

            const old = actor.get_effect(UNMIN_EFFECT_NAME);
            if (old) actor.remove_effect(old);

            actor.show();
            actor.set_opacity(255);
            actor.add_effect_with_name(UNMIN_EFFECT_NAME, _makeRestore(target.iconPos, target.dockPos, type));
        },
        WM_SIGNAL_OWNER
    );
}

export function teardownWindowEffects(dockUI) {
    const idx = _docks.indexOf(dockUI);
    if (idx !== -1) _docks.splice(idx, 1);
    if (_docks.length > 0) {
        if (_dockUI === dockUI) _dockUI = _docks[0];
    } else {
        global.window_manager.disconnectObject(WM_SIGNAL_OWNER);
        _clearEffectIdles();

        // Finish running deform effects while the original completers still
        // exist, so no window is left half-minimized after disable or lock.
        _finishRunningEffects();

        _animatingActors.length = 0;
        _pendingActor = null;
        _pendingIcon = null;
        _pendingDockPos = null;
        _pendingLaunchActor = null;
        delete global._dhruvaIsFade;
        _settings = null;
        _dockUI = null;

        _unpatchWm();
    }
}

export function animateMinimize(win, btn, dockPosition) {
    const wa = win.get_compositor_private();
    if (!wa) {
        win.minimize();
        return;
    }
    _pendingActor = wa;
    _pendingIcon = captureActorRect(btn, win);
    _pendingDockPos = dockPosition;
    win.minimize();
}

export function animateRestore(win, btn, dockPosition) {
    const wa = win.get_compositor_private();
    if (!wa) {
        win.unminimize();
        win.activate(global.get_current_time());
        return;
    }
    _pendingActor = wa;
    _pendingIcon = captureActorRect(btn, win);
    _pendingDockPos = dockPosition;
    win.unminimize();
    win.activate(global.get_current_time());
}

export function animateLaunch(win, btn, _dockPosition, iconRect = null) {
    const actor = win.get_compositor_private();
    if (!isActorAlive(actor)) return;

    // GNOME completes the map itself: immediately when we suppressed its
    // animation, or at the end of its own animation (which we must not fight).
    if (_gnomeIsAnimating('_mapping', actor)) return;

    const type = (_settings && Settings.minimizeEffect) || 'magic-lamp';
    if (type === 'none') return;

    _addAnimatingActor(actor);
    actor._isDhruvaLaunching = true;
    if (actor.remove_all_transitions) actor.remove_all_transitions();

    const old = actor.get_effect(UNMIN_EFFECT_NAME);
    if (old) actor.remove_effect(old);

    const resolvedIconRect = iconRect || captureActorRect(btn, win);
    actor.show();
    actor.set_opacity(255);
    actor.add_effect_with_name(UNMIN_EFFECT_NAME, _makeRestore(resolvedIconRect, _dockPosition, type));
}

export function fadeMinimize(win) {
    const wa = win.get_compositor_private();
    if (!wa) {
        win.minimize();
        return;
    }
    _pendingActor = wa;
    global._dhruvaIsFade = true;
    win.minimize();
}

export function fadeRestore(win) {
    const wa = win.get_compositor_private();
    if (!wa) {
        win.unminimize();
        win.activate(global.get_current_time());
        return;
    }
    _pendingActor = wa;
    global._dhruvaIsFade = true;
    win.unminimize();
    win.activate(global.get_current_time());
}