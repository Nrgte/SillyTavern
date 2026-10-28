import { chat, eventSource, event_types, saveChatDebounced } from '../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../popup.js';
import { escapeHtml } from '../../utils.js';
import { t } from '../../i18n.js';

const log = (...msg) => console.debug('[LorebookInsight]', ...msg);

/**
 * @typedef {Object} WIActivatedEntry
 * @property {string} world - The world info book (file name) the entry belongs to.
 * @property {string} uid - The entry's unique ID within its book.
 * @property {string} key - The primary keyword(s) of the entry.
 * @property {string} keysecondary - The secondary keyword(s) of the entry.
 * @property {string} comment - The entry's comment.
 * @property {WIActivation|null} activation - Why the entry was activated, if known.
 */

/**
 * @typedef {Object} WIActivation
 * @property {string} type - One of 'keyword', 'sticky', 'constant', 'decorator', 'external'.
 * @property {string} [keyword] - The trigger keyword that was found in the scan context.
 * @property {string} [logic] - The secondary keyword logic name, e.g. 'AND ANY'.
 * @property {string|null} [secondary] - A secondary keyword relevant to the activation.
 */

/**
 * Entries activated during the in-flight generation, keyed by `${world}.${uid}`.
 * They are attached to the next AI message that gets saved.
 * @type {Map<string, WIActivatedEntry>}
 */
let pendingEntries = new Map();

/**
 * Reduces a raw world info entry to the compact, persistable form stored in `message.extra`.
 * @param {Object} entry A raw world info entry as emitted by WORLD_INFO_ACTIVATED.
 * @returns {WIActivatedEntry}
 */
function toCompactEntry(entry) {
    const activation = entry._activation;
    return {
        world: entry.world ?? '',
        uid: entry.uid ?? '',
        key: entry.key ?? '',
        keysecondary: entry.keysecondary ?? '',
        comment: entry.comment ?? '',
        activation: activation ? {
            type: activation.type ?? '',
            keyword: activation.keyword ?? null,
            logic: activation.logic ?? null,
            secondary: activation.secondary ?? null,
        } : null,
    };
}

/**
 * Returns the entries recorded for the currently displayed version of a message.
 * @param {number} messageId
 * @returns {WIActivatedEntry[]|null}
 */
function getEntries(messageId) {
    const entries = chat[messageId]?.extra?.wi_activated;
    return Array.isArray(entries) && entries.length > 0 ? entries : null;
}

/**
 * Ensures the lorebook button exists in the message's extra button row.
 * @param {JQuery<HTMLElement>} $mes The `.mes` element.
 * @returns {JQuery<HTMLElement>} The button element.
 */
function ensureButton($mes) {
    let $btn = $mes.find('.extraMesButtons > .lb_insight_button');
    if ($btn.length === 0) {
        $btn = $('<div class="mes_button lb_insight_button fa-solid fa-book-open"></div>');
        $btn.attr('title', t`World info entries activated for this response`);
        $btn.attr('data-i18n', '[title]World info entries activated for this response');
        $mes.find('.extraMesButtons').append($btn);
    }
    return $btn;
}

/**
 * Syncs the visibility of a single message's button with its recorded data.
 * @param {number} messageId
 */
function syncButton(messageId) {
    const $mes = $(`#chat .mes[mesid="${messageId}"]`);
    if ($mes.length === 0) {
        return;
    }
    const $btn = ensureButton($mes);
    $btn.toggle(!!getEntries(messageId));
}

/**
 * Re-syncs the buttons of all rendered messages.
 * Needed whenever the DOM is rebuilt or message IDs shift (chat load,
 * loading older messages, message deletion).
 */
function syncAllButtons() {
    $('#chat .mes').each((_, el) => {
        const messageId = Number($(el).attr('mesid'));
        if (!Number.isNaN(messageId)) {
            syncButton(messageId);
        }
    });
}

/**
 * Builds the activation-reason badge HTML for a stored entry.
 * @param {Object|null} activation The stored activation info (see WIActivation).
 * @returns {string} Empty string if there is no activation info (e.g. legacy data).
 */
function activationBadge(activation) {
    if (!activation || !activation.type) {
        return '';
    }

    const labels = {
        keyword: { label: t`Keyword`, hint: t`The trigger keyword was found in the scan context` },
        sticky: { label: t`Sticky`, hint: t`Kept active because a previous activation made it sticky` },
        constant: { label: t`Constant`, hint: t`Always activated (constant entry)` },
        decorator: { label: t`@@activate`, hint: t`Forced on by the @@activate decorator` },
        external: { label: t`External`, hint: t`Activated externally (e.g. via a forced activation command)` },
    };
    const { label, hint } = labels[activation.type] ?? { label: activation.type, hint: '' };

    const details = [];
    if (activation.type === 'keyword') {
        if (activation.keyword) {
            details.push(`<code class="lb_insight_kw">${escapeHtml(activation.keyword)}</code>`);
        }
        if (activation.logic) {
            details.push(`<span class="lb_insight_dim">${escapeHtml(activation.logic)}</span>`);
        }
        if (activation.secondary) {
            details.push(`<code class="lb_insight_kw">${escapeHtml(activation.secondary)}</code>`);
        }
    }

    return `<div class="lb_insight_activation" title="${escapeHtml(hint)}">
        <span class="lb_insight_activation_type">${escapeHtml(label)}</span>
        ${details.join(' ')}
    </div>`;
}

/**
 * Builds the HTML content of the entries popup for a message.
 * @param {number} messageId
 * @returns {string}
 */
function buildPopupContent(messageId) {
    const entries = getEntries(messageId) ?? [];
    const header = t`World info entries activated for this response (${entries.length})`;
    const formatKeys = (value) => Array.isArray(value) ? value.join(', ') : (value ?? '');
    const items = entries.map((entry) => {
        const bookName = escapeHtml((entry.world ?? 'unknown').replace(/\.json$/i, ''));
        const uid = escapeHtml(entry.uid ?? '');
        const key = escapeHtml(formatKeys(entry.key));
        const keysecondary = escapeHtml(formatKeys(entry.keysecondary));
        const comment = escapeHtml(entry.comment ?? '');
        return `<div class="lb_insight_item">
            <div class="lb_insight_item_header">
                <span class="lb_insight_item_book" title="${bookName}">${bookName}</span>
                <span class="lb_insight_item_uid">#${uid}</span>
            </div>
            ${activationBadge(entry.activation)}
            ${key !== '' ? `<div class="lb_insight_item_line"><span class="lb_insight_item_label">${t`Primary keywords`}</span>${key}</div>` : ''}
            ${keysecondary !== '' ? `<div class="lb_insight_item_line"><span class="lb_insight_item_label">${t`Secondary keywords`}</span>${keysecondary}</div>` : ''}
            ${comment !== '' ? `<div class="lb_insight_item_comment">${comment}</div>` : ''}
        </div>`;
    }).join('');
    return `<div class="lb_insight_popup">
        <h3>${header}</h3>
        ${items}
    </div>`;
}

/**
 * A new generation starts. Discard entries that were activated by a previous
 * generation but never produced a saved message (e.g. quiet/impersonate runs).
 * @param {string} _generationType
 * @param {Object} _options
 * @param {boolean} [dryRun]
 */
function onGenerationStarted(_generationType, _options, dryRun = false) {
    if (dryRun) {
        return;
    }
    pendingEntries.clear();
}

/**
 * World info scan finished with activated entries.
 * @param {Object[]} entries
 */
function onWorldInfoActivated(entries) {
    if (!Array.isArray(entries)) {
        return;
    }
    for (const entry of entries) {
        if (!entry || !entry.world || entry.uid === undefined) {
            continue;
        }
        pendingEntries.set(`${entry.world}.${entry.uid}`, toCompactEntry(entry));
    }
    log(`activated ${pendingEntries.size} entries`);
}

/**
 * A message was saved. If it is an AI message and entries are pending,
 * record them on the message's `extra` (persisted and follows swipes).
 * @param {number} messageId
 * @param {string} _type
 */
function onMessageReceived(messageId, _type) {
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) {
        return;
    }
    if (pendingEntries.size === 0) {
        return;
    }

    message.extra = message.extra ?? {};
    message.extra.wi_activated = Array.from(pendingEntries.values());
    pendingEntries.clear();

    saveChatDebounced();
    log(`recorded ${message.extra.wi_activated.length} entries on message ${messageId}`);
}

/**
 * A message was rendered into the DOM (covers streaming and non-streaming).
 * @param {number} messageId
 */
function onCharacterMessageRendered(messageId) {
    syncButton(messageId);
}

/**
 * The user swiped a message; the visible content (and its `extra`) changed.
 * @param {number} messageId
 */
function onMessageSwiped(messageId) {
    syncButton(messageId);
}

/**
 * A message was deleted; message IDs shifted, so re-sync everything.
 * @param {number} _newChatLength
 */
function onMessageDeleted(_newChatLength) {
    syncAllButtons();
}

function onMessageUpdated() {
    syncAllButtons();
}

function onMessageEdited() {
    syncAllButtons();
}

/**
 * The chat array was replaced and all messages were re-rendered.
 */
async function onChatLoaded() {
    syncAllButtons();
}

/**
 * Older messages were prepended to the DOM.
 */
async function onMoreMessagesLoaded() {
    syncAllButtons();
}

function onButtonClick(event) {
    event.preventDefault();
    const $mes = $(event.currentTarget).closest('.mes');
    const messageId = Number($mes.attr('mesid'));
    if (Number.isNaN(messageId) || !getEntries(messageId)) {
        return;
    }
    callGenericPopup(buildPopupContent(messageId), POPUP_TYPE.DISPLAY);
}

/**
 * Extension entry point.
 */
export async function init() {
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageUpdated);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    eventSource.on(event_types.CHAT_LOADED, onChatLoaded);
    eventSource.on(event_types.MORE_MESSAGES_LOADED, onMoreMessagesLoaded);

    $(document).on('click', '.lb_insight_button', onButtonClick);

    syncAllButtons();
    log('activated');
}
