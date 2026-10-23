/**
 * Nrgte fork — runtime generation-identity guard.
 *
 * Watches the group generation loop for the "hijacked identity" bug class.
 * When a member is drafted (GROUP_MEMBER_DRAFTED) this file remembers that
 * member and, on each in-cone checkpoint event, verifies that the app-wide
 * `this_chid` / `name2` selection globals still point at the drafted member.
 * A divergence means something wrote those globals mid-generation (a UI
 * action, a prompt-manager dry run, ...), which is exactly the class of bug
 * the fork's pinned generation identity (`force_chid` inside `Generate`,
 * see script.js / group-chats.js) is supposed to prevent.
 *
 * Warn-only by design: this file never writes the selection globals, so it
 * cannot fix nor mask a divergence.
 *
 * Fork-owned file (CSS twin: css/Nrgte/): nothing else imports it, so it is
 * safe to delete along with the <script> tag in index.html.
 */

import { characters, eventSource, event_types, name2, this_chid } from '../../script.js';
import { group_generation_id, is_group_generating } from '../group-chats.js';

const TAG = '[Nrgte] identity guard';

/**
 * The member currently generating, as announced by the group loop.
 * @type {{chid: (number|string), name: string, generationId: (number|null)}|null}
 */
let expected = null;

/**
 * Compare the selection globals against the drafted member.
 * Only meaningful during a group generation: the loop drafts each member
 * right before its inner Generate (including continuations and tool-call
 * recursions).
 */
function checkIdentity() {
    if (!expected || !is_group_generating) {
        return;
    }
    if (group_generation_id !== expected.generationId) {
        // The wrapper restarted (or was aborted) between the draft and this checkpoint.
        expected = null;
        return;
    }
    if (this_chid !== expected.chid) {
        console.warn(`${TAG}: this_chid is ${String(this_chid)}, but the drafted member is ${String(expected.chid)} ("${expected.name}") — selection globals were written during generation`);
    } else if (name2 !== expected.name) {
        console.warn(`${TAG}: name2 is "${name2}", but the drafted member is "${expected.name}" — selection name changed during generation`);
    }
}

/**
 * Register a listener, degrading to a warning instead of crashing if
 * upstream renames or removes the event.
 */
function onEvent(typeKey, handler) {
    if (event_types[typeKey] === undefined) {
        console.warn(`${TAG}: event "${typeKey}" not found in events.js — guard degrades`);
        return;
    }
    eventSource.on(event_types[typeKey], handler);
}

// The group loop drafts each member right before its Generate (group-chats.js).
onEvent('GROUP_MEMBER_DRAFTED', chId => {
    if (!is_group_generating) {
        return;
    }
    expected = { chid: chId, name: characters[chId]?.name ?? '', generationId: group_generation_id };
});

// In-cone checkpoints. Every one of the three emits passes `dryRun` as its
// final argument (script.js :4317, :4339, :5336); dry-run checkpoints are
// skipped so a prompt-manager token count mid-generation — which takes the
// group dry-run path that writes setCharacterId(memberIds[0]) — cannot
// false-positive.
onEvent('GENERATION_STARTED', (_type, _opts, dryRun) => {
    if (!dryRun) {
        checkIdentity();
    }
});

onEvent('GENERATION_AFTER_COMMANDS', (_type, _opts, dryRun) => {
    if (!dryRun) {
        checkIdentity();
    }
});

onEvent('GENERATE_AFTER_DATA', (_data, dryRun) => {
    if (!dryRun) {
        checkIdentity();
    }
});

// The wrapper finished: drop the expectation. (The loop's `finally` has
// already cleared this_chid/name2 by this point; nothing relevant fires after.)
onEvent('GROUP_WRAPPER_FINISHED', () => {
    expected = null;
});
