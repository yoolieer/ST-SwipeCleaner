import { getContext } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';

const extensionName = 'ST-SwipeCleaner';
const extensionWebPath = `/scripts/extensions/third-party/${extensionName}`;
const settingsKey = 'st_swipe_cleaner';

const DEFAULT_SETTINGS = Object.freeze({
    keepFloors: 20,
    autoSave: true,
    includeHidden: true,
    buttonsEnabled: true,
    buttonVisibility: Object.freeze({
        keepCurrent: true,
        deleteSpecified: true,
        pruneOld: true,
    }),
});

const BUTTON_KEEP_CURRENT = '清理当前(保留当前)';
const BUTTON_DELETE_SPECIFIED = '清理当前(删除指定)';
const BUTTON_PRUNE_OLD = '清理旧swipe';

const BUTTON_INFO = Object.freeze({
    keep: '清理当前(保留当前)：清理当前楼层其它 swipes',
    delete: '清理当前(删除指定)：清理当前楼层指定 swipes（支持输入 x-y 或 x,y,z）',
    prune: '清理过去楼层的swipe：当总楼层为 0-99 时，若保留最近楼层数设置为 20 层，则删除0-79层所有无效swipes',
});

let isRunning = false;

function clampInt(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(Math.max(Math.trunc(n), min), max);
}

function toArrayFromNumericObject(maybeObject, length, fallbackFactory) {
    if (Array.isArray(maybeObject)) {
        const arr = maybeObject.slice();
        return Array.from({ length }, (_, i) => arr[i] ?? fallbackFactory(i));
    }
    if (maybeObject && typeof maybeObject === 'object') {
        return Array.from({ length }, (_, i) => {
            const byNumberKey = maybeObject[i];
            const byStringKey = maybeObject[String(i)];
            return (byNumberKey ?? byStringKey) ?? fallbackFactory(i);
        });
    }
    return Array.from({ length }, (_, i) => fallbackFactory(i));
}

function normalizeSwipeInfoEntry(entry, fallbackExtra, message) {
    const base = {
        send_date: message?.send_date,
        gen_started: message?.gen_started,
        gen_finished: message?.gen_finished,
        extra: fallbackExtra ?? {},
    };

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return base;
    }

    if (Object.hasOwn(entry, 'extra')) {
        const extra = (entry.extra && typeof entry.extra === 'object' && !Array.isArray(entry.extra)) ? entry.extra : {};
        return {
            ...entry,
            send_date: entry.send_date ?? base.send_date,
            gen_started: entry.gen_started ?? base.gen_started,
            gen_finished: entry.gen_finished ?? base.gen_finished,
            extra,
        };
    }

    return { ...base, extra: entry };
}

function normalizeSwipeState(message) {
    const swipesRaw = Array.isArray(message.swipes) ? message.swipes : [];
    const baseSwipe = message.mes ?? '';
    const swipes = (swipesRaw.length > 0 ? swipesRaw : [baseSwipe]).map(s => s ?? '');
    const swipeIdFromField = typeof message.swipe_id === 'number'
        ? clampInt(message.swipe_id, 0, swipes.length - 1)
        : 0;
    let swipeId = swipeIdFromField;
    if (typeof message.mes === 'string') {
        const idx = swipes.indexOf(message.mes);
        if (idx >= 0) swipeId = idx;
    }

    const swipeInfoRaw = toArrayFromNumericObject(message.swipe_info, swipes.length, () => undefined);
    const swipeInfo = swipeInfoRaw.map((entry, i) => {
        const fallbackExtra = i === swipeId ? (message.extra ?? {}) : {};
        return normalizeSwipeInfoEntry(entry, fallbackExtra, message);
    });
    const swipeData = toArrayFromNumericObject(message.variables, swipes.length, () => ({}));

    return { swipes, swipeInfo, swipeData, swipeId };
}

function parseSwipeSpec(input, swipeCount) {
    const cleaned = String(input ?? '')
        .trim()
        .replaceAll('，', ',')
        .replaceAll(' ', '');
    if (!cleaned) return new Set();

    const result = new Set();
    const parts = cleaned.split(',').filter(Boolean);
    for (const part of parts) {
        const rangeMatch = part.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
            let start = Number(rangeMatch[1]);
            let end = Number(rangeMatch[2]);
            if (!Number.isInteger(start) || !Number.isInteger(end)) {
                throw new Error(`删除范围无效：${part}`);
            }
            if (start > end) [start, end] = [end, start];
            for (let i = start; i <= end; i++) result.add(i - 1);
            continue;
        }

        const singleMatch = part.match(/^(\d+)$/);
        if (singleMatch) {
            result.add(Number(singleMatch[1]) - 1);
            continue;
        }

        throw new Error(`删除格式无效：${part}`);
    }

    for (const idx of result) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= swipeCount) {
            throw new Error(`swipe 序号超出范围：${idx + 1}（有效范围：1-${swipeCount}）`);
        }
    }

    return result;
}

function findTargetMessageId(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg) continue;
        if (msg.is_user) continue;
        if (msg.is_system) continue;
        return i;
    }
    return null;
}

function markChatTainted(context) {
    if (context.chatMetadata) {
        context.chatMetadata.tainted = true;
        context.chatMetadata['tainted'] = true;
    }
}

function updateSwipeCounterOnly(messageId, message) {
    const $mes = $(`#chat > .mes[mesid="${messageId}"]`);
    if (!$mes.length) return;
    if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number') {
        $mes.find('.swipes-counter').text(`${message.swipe_id + 1}\u200b/\u200b${message.swipes.length}`);
    }
}

function updateTimestampUi(messageId, message) {
    const $mes = $(`#chat > .mes[mesid="${messageId}"]`);
    if (!$mes.length) return;
    const timestamp = message.send_date !== undefined ? String(message.send_date) : '';
    if (!timestamp) return;
    const api = message?.extra?.api ? String(message.extra.api) : '';
    const model = message?.extra?.model ? String(message.extra.model) : '';
    $mes.attr('timestamp', timestamp);
    $mes.find('.timestamp').text(timestamp).attr('title', `${api ? api + ' - ' : ''}${model}`);
}

function keepOnlyCurrentSwipe(message, { quiet = false } = {}) {
    const { swipes, swipeInfo, swipeData, swipeId } = normalizeSwipeState(message);
    if (swipes.length <= 1) {
        return { changed: false };
    }

    const keptText = swipes[swipeId] ?? '';
    const keptInfo = swipeInfo[swipeId] ?? {};
    const keptData = swipeData[swipeId] ?? {};

    message.swipes = [keptText];
    message.swipe_info = [keptInfo];
    message.variables = [keptData];
    message.swipe_id = 0;
    message.mes = keptText;
    message.send_date = keptInfo.send_date ?? message.send_date;
    message.gen_started = keptInfo.gen_started ?? message.gen_started;
    message.gen_finished = keptInfo.gen_finished ?? message.gen_finished;
    message.extra = structuredClone(keptInfo.extra ?? {});

    if (!quiet) {
        toastr.success('已清理当前楼层其它 swipes。');
    }
    return { changed: true, removedCount: swipes.length - 1 };
}

function deleteSpecifiedSwipes(message, deleteSet) {
    const { swipes, swipeInfo, swipeData, swipeId } = normalizeSwipeState(message);
    if (swipes.length <= 1) {
        return { changed: false };
    }

    const toKeep = [];
    for (let i = 0; i < swipes.length; i++) {
        if (!deleteSet.has(i)) toKeep.push(i);
    }
    if (toKeep.length === 0) {
        throw new Error('至少保留一条 swipe。');
    }

    let selectedOriginalIndex;
    if (!deleteSet.has(swipeId)) {
        selectedOriginalIndex = swipeId;
    } else {
        selectedOriginalIndex = toKeep.find(i => i > swipeId);
        if (selectedOriginalIndex === undefined) {
            selectedOriginalIndex = toKeep[toKeep.length - 1];
        }
    }
    const newSwipeId = toKeep.indexOf(selectedOriginalIndex);

    const nextSwipes = toKeep.map(i => swipes[i] ?? '');
    const nextInfo = toKeep.map(i => swipeInfo[i] ?? {});
    const nextData = toKeep.map(i => swipeData[i] ?? {});

    message.swipes = nextSwipes;
    message.swipe_info = nextInfo;
    message.variables = nextData;
    message.swipe_id = newSwipeId;
    message.mes = nextSwipes[newSwipeId] ?? '';
    message.send_date = nextInfo?.[newSwipeId]?.send_date ?? message.send_date;
    message.gen_started = nextInfo?.[newSwipeId]?.gen_started ?? message.gen_started;
    message.gen_finished = nextInfo?.[newSwipeId]?.gen_finished ?? message.gen_finished;
    message.extra = structuredClone(nextInfo?.[newSwipeId]?.extra ?? message.extra ?? {});

    return { changed: true, removedCount: swipes.length - nextSwipes.length };
}

function pruneOldSwipes(chat, keepFloors, includeHidden) {
    const keep = clampInt(keepFloors, 0, chat.length);
    const cutoff = Math.max(0, chat.length - keep);

    let affectedMessages = 0;
    let removedSwipes = 0;
    const affectedMessageIds = [];

    for (let messageId = 0; messageId < cutoff; messageId++) {
        const msg = chat[messageId];
        if (!msg) continue;
        if (msg.is_user) continue;
        if (msg.is_system && !includeHidden) continue;

        const result = keepOnlyCurrentSwipe(msg, { quiet: true });
        if (result.changed) {
            affectedMessages += 1;
            removedSwipes += result.removedCount ?? 0;
            affectedMessageIds.push(messageId);
        }
    }

    return { changed: affectedMessageIds.length > 0, affectedMessageIds, affectedMessages, removedSwipes, keep, cutoff };
}

async function maybeSave(context, settings) {
    if (!settings.autoSave) return { saved: false };
    try {
        await context.saveChat();
        return { saved: true };
    } catch (err) {
        console.warn('[ST-SwipeCleaner] saveChat failed', err);
        return { saved: false, error: err };
    }
}

function safeSwipeRefresh(context) {
    try {
        const refresh = context?.swipe?.refresh;
        if (typeof refresh === 'function') {
            refresh();
            return true;
        }
    } catch (err) {
        console.warn('[ST-SwipeCleaner] swipe.refresh failed', err);
    }
    return false;
}

async function emitMessageRendered(context, messageId, message) {
    try {
        const eventSource = context?.eventSource;
        const eventTypes = context?.eventTypes;
        if (!eventSource || !eventTypes) return false;
        const eventType = message?.is_user
            ? eventTypes.USER_MESSAGE_RENDERED
            : eventTypes.CHARACTER_MESSAGE_RENDERED;
        if (!eventType) return false;
        await eventSource.emit(eventType, messageId);
        return true;
    } catch (err) {
        console.warn('[ST-SwipeCleaner] emit render event failed', err);
        return false;
    }
}

function ensureButtons(context, settings) {
    if (!settings.buttonsEnabled) return;

    const $sendForm = $('#send_form');
    if (!$sendForm.length) return;

    const visibility = {
        ...DEFAULT_SETTINGS.buttonVisibility,
        ...(settings.buttonVisibility ?? {}),
    };
    const hasAnyEnabled = Object.values(visibility).some(Boolean);

    if (!hasAnyEnabled) {
        $('#st_swipe_cleaner_bar').remove();
        return;
    }

    const resolveQrHost = () => {
        const $qrBar = $('#qr--bar').first();
        if (!$qrBar.length) return null;

        const $directButtons = $qrBar.children('.qr--buttons');
        const $likelyCombinedHolder = $directButtons
            .filter(function () { return $(this).children('.qr--buttons').length > 0; })
            .first();
        if ($likelyCombinedHolder.length) return $likelyCombinedHolder;

        if ($directButtons.length === 1) {
            const $only = $directButtons.first();
            if ($only.children('.qr--button').length === 0) {
                return $only;
            }
        }

        return $qrBar;
    };

    const ensureBar = () => {
        let $bar = $('#st_swipe_cleaner_bar');
        const $qrHost = resolveQrHost();

        if (!$bar.length) {
            $bar = $('<div id="st_swipe_cleaner_bar" class="qr--buttons st-swipe-cleaner-set"></div>');
        }

        const inQr = Boolean($qrHost && $qrHost.length);
        $bar.toggleClass('st-swipe-cleaner-fallback', !inQr);

        const $desiredHost = inQr ? $qrHost : $sendForm;
        if ($bar.parent()[0] !== $desiredHost[0]) {
            if (inQr) {
                $bar.appendTo($desiredHost);
            } else {
                $bar.prependTo($desiredHost);
            }
        }

        return $bar;
    };

    const $bar = ensureBar();

    const ensureButton = (id, label, title, enabled, onClick) => {
        const $existing = $bar.find(`#${id}`);
        if (!enabled) {
            if ($existing.length) $existing.remove();
            return;
        }
        if ($existing.length) return;
        const $btn = $(`<div id="${id}" class="qr--button menu_button interactable"></div>`)
            .text(label)
            .attr('title', title)
            .on('click', onClick)
            .on('pointerdown', (e) => e.preventDefault());
        $bar.append($btn);
    };

    ensureButton('st_swipe_cleaner_btn_keep', BUTTON_KEEP_CURRENT, '清理当前楼层其它 swipes（保留当前）', visibility.keepCurrent, async () => {
        await runKeepCurrent(context, settings);
    });

    ensureButton('st_swipe_cleaner_btn_delete', BUTTON_DELETE_SPECIFIED, '删除当前楼层指定 swipes', visibility.deleteSpecified, async () => {
        await runDeleteSpecified(context, settings);
    });

    ensureButton('st_swipe_cleaner_btn_prune', BUTTON_PRUNE_OLD, '清理旧楼层无用 swipes（保留最近 N 层完整历史）', visibility.pruneOld, async () => {
        await runPruneOld(context, settings);
    });
}

async function runKeepCurrent(context, settings) {
    if (isRunning) return;
    isRunning = true;
    try {
        const { chat } = context;
        const messageId = findTargetMessageId(chat);
        if (messageId === null) {
            toastr.warning('找不到可处理的 AI 楼层。');
            return { changed: false };
        }
        const message = chat[messageId];
        const result = keepOnlyCurrentSwipe(message, { quiet: true });
        if (!result.changed) {
            toastr.info('当前楼层没有其它 swipe，无需清理。');
            return { changed: false };
        }

        markChatTainted(context);
        updateSwipeCounterOnly(messageId, message);
        updateTimestampUi(messageId, message);
        context.updateMessageBlock(messageId, message);
        safeSwipeRefresh(context);
        await emitMessageRendered(context, messageId, message);

        const saveResult = await maybeSave(context, settings);
        if (saveResult.saved) {
            toastr.success('已清理并保存。');
        } else if (settings.autoSave && saveResult.error) {
            toastr.warning('已清理，但保存失败（未保存）。');
        } else {
            toastr.success('已清理（未保存）。');
        }
        return { changed: true };
    } catch (err) {
        toastr.error(String(err?.message ?? err), '清理失败');
        return { changed: false, error: err };
    } finally {
        isRunning = false;
    }
}

async function runDeleteSpecified(context, settings, { spec } = {}) {
    if (isRunning) return;
    isRunning = true;
    try {
        const { chat } = context;
        const messageId = findTargetMessageId(chat);
        if (messageId === null) {
            toastr.warning('找不到可处理的 AI 楼层。');
            return { changed: false };
        }
        const message = chat[messageId];
        const { swipes, swipeId } = normalizeSwipeState(message);
        if (swipes.length <= 1) {
            toastr.info('当前楼层没有可删除的 swipe。');
            return { changed: false };
        }

        let inputSpec = spec;
        if (!inputSpec) {
            const current = swipeId + 1;
            inputSpec = prompt(
                `请输入要删除的 swipe 序号（1-${swipes.length}），支持 x-y 或 x,y,z\n\n` +
                `当前选中：${current}\n` +
                `示例：2-4 或 1,3,5`,
            );
            if (inputSpec === null) return { changed: false };
        }

        const deleteSet = parseSwipeSpec(inputSpec, swipes.length);
        if (deleteSet.size === 0) return { changed: false };

        const result = deleteSpecifiedSwipes(message, deleteSet);
        if (!result.changed) return { changed: false };

        markChatTainted(context);
        updateSwipeCounterOnly(messageId, message);
        updateTimestampUi(messageId, message);
        context.updateMessageBlock(messageId, message);
        safeSwipeRefresh(context);
        await emitMessageRendered(context, messageId, message);

        const saveResult = await maybeSave(context, settings);
        if (saveResult.saved) {
            toastr.success('已删除并保存。');
        } else if (settings.autoSave && saveResult.error) {
            toastr.warning('已删除，但保存失败（未保存）。');
        } else {
            toastr.success('已删除（未保存）。');
        }
        return { changed: true };
    } catch (err) {
        toastr.error(String(err?.message ?? err), '删除失败');
        return { changed: false, error: err };
    } finally {
        isRunning = false;
    }
}

async function runPruneOld(context, settings, { keepFloors } = {}) {
    if (isRunning) return;
    isRunning = true;
    try {
        const { chat } = context;
        const keep = keepFloors !== undefined ? clampInt(keepFloors, 0, chat.length) : settings.keepFloors;
        const result = pruneOldSwipes(chat, keep, settings.includeHidden);
        if (!result.changed) {
            toastr.info(`没有需要清理的旧 swipe（保留最近 ${keep} 层）。`);
            return { changed: false };
        }

        markChatTainted(context);
        result.affectedMessageIds.forEach(id => {
            updateSwipeCounterOnly(id, chat[id]);
        });
        safeSwipeRefresh(context);
        await Promise.all(result.affectedMessageIds.map(id => emitMessageRendered(context, id, chat[id])));

        const saveResult = await maybeSave(context, settings);
        if (saveResult.saved) {
            toastr.success(`已清理 ${result.affectedMessages} 层（删除 ${result.removedSwipes} 条），并已保存。`);
        } else if (settings.autoSave && saveResult.error) {
            toastr.warning(`已清理 ${result.affectedMessages} 层（删除 ${result.removedSwipes} 条），但保存失败（未保存）。`);
        } else {
            toastr.success(`已清理 ${result.affectedMessages} 层（删除 ${result.removedSwipes} 条），未保存。`);
        }
        return { changed: true };
    } catch (err) {
        toastr.error(String(err?.message ?? err), '清理失败');
        return { changed: false, error: err };
    } finally {
        isRunning = false;
    }
}

function registerSlashCommands(context, settings) {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'swipecleaner',
        helpString: '清理 swipe：/swipecleaner | /swipecleaner 1-3 | /swipecleaner 1,3 | /swipecleaner keep=20',
        namedArgumentList: [
            new SlashCommandNamedArgument('keep', '保留最近楼层数（清理旧楼层 swipes）', ARGUMENT_TYPE.NUMBER, false, false),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('swipe 序号（例如 1-3 或 1,3,5）', ARGUMENT_TYPE.STRING, false, false),
        ],
        callback: async (args, value) => {
            const keepRaw = args?.keep !== undefined ? Number(args.keep) : undefined;
            const keep = Number.isFinite(keepRaw) ? Math.trunc(keepRaw) : undefined;
            const spec = value !== undefined && value !== null ? String(value).trim() : '';

            if (keep !== undefined && spec) {
                throw new Error('请只使用一种方式：keep= 或 swipe 序号。');
            }

            if (keep !== undefined) {
                await runPruneOld(context, settings, { keepFloors: keep });
                return 'ok';
            }

            if (spec) {
                await runDeleteSpecified(context, settings, { spec });
                return 'ok';
            }

            await runKeepCurrent(context, settings);
            return 'ok';
        },
    }));
}

function ensureSettings(context) {
    const extSettings = context.extensionSettings;
    if (!extSettings[settingsKey]) {
        extSettings[settingsKey] = {
            ...DEFAULT_SETTINGS,
            buttonVisibility: { ...DEFAULT_SETTINGS.buttonVisibility },
        };
        context.saveSettingsDebounced();
    }
    const current = extSettings[settingsKey];
    let changed = false;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (current[key] === undefined) {
            current[key] = value;
            changed = true;
        }
    }
    if (!current.buttonVisibility || typeof current.buttonVisibility !== 'object') {
        current.buttonVisibility = { ...DEFAULT_SETTINGS.buttonVisibility };
        changed = true;
    } else {
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS.buttonVisibility)) {
            if (current.buttonVisibility[key] === undefined) {
                current.buttonVisibility[key] = value;
                changed = true;
            }
        }
    }
    if (changed) {
        context.saveSettingsDebounced();
    }
    return extSettings[settingsKey];
}

function wireSettingsUi(context, settings) {
    const $keepFloors = $('#st_swipe_cleaner_keep_floors');
    const $autoSave = $('#st_swipe_cleaner_auto_save');
    const $includeHidden = $('#st_swipe_cleaner_include_hidden');
    const $btnKeep = $('#st_swipe_cleaner_btn_keep_enabled');
    const $btnDelete = $('#st_swipe_cleaner_btn_delete_enabled');
    const $btnPrune = $('#st_swipe_cleaner_btn_prune_enabled');
    const $defaults = $('#st_swipe_cleaner_apply_defaults');

    $keepFloors.val(String(settings.keepFloors));
    $autoSave.prop('checked', Boolean(settings.autoSave));
    $includeHidden.prop('checked', Boolean(settings.includeHidden));
    $btnKeep.prop('checked', Boolean(settings.buttonVisibility?.keepCurrent ?? true));
    $btnDelete.prop('checked', Boolean(settings.buttonVisibility?.deleteSpecified ?? true));
    $btnPrune.prop('checked', Boolean(settings.buttonVisibility?.pruneOld ?? true));

    $keepFloors.on('change', () => {
        settings.keepFloors = Math.max(0, Math.trunc(Number($keepFloors.val())));
        context.saveSettingsDebounced();
    });
    $autoSave.on('change', () => {
        settings.autoSave = Boolean($autoSave.prop('checked'));
        context.saveSettingsDebounced();
    });
    $includeHidden.on('change', () => {
        settings.includeHidden = Boolean($includeHidden.prop('checked'));
        context.saveSettingsDebounced();
    });
    const syncButtonVisibility = () => {
        settings.buttonVisibility = {
            keepCurrent: Boolean($btnKeep.prop('checked')),
            deleteSpecified: Boolean($btnDelete.prop('checked')),
            pruneOld: Boolean($btnPrune.prop('checked')),
        };
        context.saveSettingsDebounced();
        ensureButtons(context, settings);
    };
    $btnKeep.on('change', syncButtonVisibility);
    $btnDelete.on('change', syncButtonVisibility);
    $btnPrune.on('change', syncButtonVisibility);

    const ensureTooltip = () => {
        let $tooltip = $('#st_swipe_cleaner_tooltip');
        if ($tooltip.length) return $tooltip;
        $tooltip = $('<div id="st_swipe_cleaner_tooltip" class="st-swipe-cleaner-tooltip"></div>').hide();
        $('body').append($tooltip);
        return $tooltip;
    };

    const positionTooltip = ($tooltip, evt) => {
        const padding = 12;
        const margin = 8;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const rect = $tooltip[0].getBoundingClientRect();
        let x = evt.clientX + padding;
        let y = evt.clientY + padding;
        if (x + rect.width + margin > vw) x = evt.clientX - rect.width - padding;
        if (y + rect.height + margin > vh) y = evt.clientY - rect.height - padding;
        if (x < margin) x = margin;
        if (y < margin) y = margin;
        $tooltip.css({ left: `${x}px`, top: `${y}px` });
    };

    $('.st-swipe-cleaner-option[data-info]').each(function () {
        const $item = $(this);
        const key = $item.data('info');
        const text = BUTTON_INFO?.[key];
        if (!text) return;

        $item
            .off('.swipePrunerTooltip')
            .on('mouseenter.swipePrunerTooltip', (evt) => {
                const $tooltip = ensureTooltip();
                $tooltip.text(text).show();
                positionTooltip($tooltip, evt);
            })
            .on('mousemove.swipePrunerTooltip', (evt) => {
                const $tooltip = $('#st_swipe_cleaner_tooltip');
                if ($tooltip.length && $tooltip.is(':visible')) {
                    positionTooltip($tooltip, evt);
                }
            })
            .on('mouseleave.swipePrunerTooltip', () => {
                $('#st_swipe_cleaner_tooltip').hide();
            });
    });
    $defaults.on('click', () => {
        Object.assign(settings, {
            ...DEFAULT_SETTINGS,
            buttonVisibility: { ...DEFAULT_SETTINGS.buttonVisibility },
        });
        $keepFloors.val(String(settings.keepFloors));
        $autoSave.prop('checked', Boolean(settings.autoSave));
        $includeHidden.prop('checked', Boolean(settings.includeHidden));
        $btnKeep.prop('checked', Boolean(settings.buttonVisibility.keepCurrent));
        $btnDelete.prop('checked', Boolean(settings.buttonVisibility.deleteSpecified));
        $btnPrune.prop('checked', Boolean(settings.buttonVisibility.pruneOld));
        context.saveSettingsDebounced();
        ensureButtons(context, settings);
        toastr.success('已恢复默认设置');
    });
}

jQuery(async () => {
    const context = getContext();
    const settings = ensureSettings(context);

    // CSS
    $('head').append(`<link rel="stylesheet" type="text/css" href="${extensionWebPath}/styles.css">`);

    // Settings UI
    const settingsHtml = await $.get(`${extensionWebPath}/settings.html`);
    const $settingsRoot = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $settingsRoot.append(settingsHtml);
    wireSettingsUi(context, settings);

    // Slash command
    registerSlashCommands(context, settings);

    // Buttons
    ensureButtons(context, settings);

    // QR bar might appear after other extensions initialize; re-home our buttons when it does.
    const observer = new MutationObserver(() => ensureButtons(context, settings));
    observer.observe(document.body, { childList: true, subtree: true });
});
