import type { ModelDownloadState, ModelDownloader } from '../models/model-download.ts';
import type { TranslationSessionState, TranslationSession } from '../poc/translation-session.ts';
import type { OfflineClient, OfflineClientState } from '../offline/client.ts';

type OfflineModelPort = Pick<ModelDownloader, 'getState' | 'subscribe' | 'hasMemoryModel'>;
type OfflineSessionPort = Pick<TranslationSession, 'getState' | 'subscribe'>;

export interface OfflineView {
  readonly summary: string;
  readonly status: string;
  readonly help: string;
  readonly ready: boolean;
  readonly appAssetsComplete: boolean;
  readonly controlledByCurrentBuild: boolean;
  readonly updateAvailable: boolean;
  readonly waitingUpdateIncomplete: boolean;
  readonly needsInitialReload: boolean;
  readonly reloadLabel: string;
  readonly busy: boolean;
  readonly busyReason: string;
  readonly canPrepare: boolean;
  readonly showPrepare: boolean;
  readonly prepareLabel: string;
  readonly canRetry: boolean;
  readonly canClear: boolean;
  readonly clearDisabledReason: string;
}

const ACTIVE_DOWNLOAD_PHASES = new Set<ModelDownloadState['phase']>([
  'checking', 'downloading', 'verifying', 'cancelling', 'clearing', 'updating-retention',
]);

function isCompleteAssetStatus(status: OfflineClientState['controller']): boolean {
  return Boolean(status?.complete && status.resourceCount > 0 && status.totalBytes > 0);
}

function modelBusyReason(state: ModelDownloadState): string {
  switch (state.phase) {
    case 'checking': return 'モデルの保存状態を確認中は、オフライン設定を変更できません。';
    case 'downloading':
    case 'verifying': return 'モデルの取得中は、オフライン設定を変更できません。';
    case 'cancelling': return 'モデル取得の中止中は、オフライン設定を変更できません。';
    case 'clearing': return 'モデルの削除中は、オフライン設定を変更できません。';
    case 'updating-retention': return 'モデルの保持期間を更新中は、オフライン設定を変更できません。';
    default: return '';
  }
}

function sessionBusyReason(state: TranslationSessionState): string {
  if (state.cancelling) return '処理の中止中は、オフライン設定を変更できません。';
  switch (state.operation) {
    case 'loading': return 'モデルのロード中は、オフライン設定を変更できません。';
    case 'translating': return '翻訳中は、オフライン設定を変更できません。';
    case 'unloading': return 'モデルのロード解除中は、オフライン設定を変更できません。';
    default: return '';
  }
}

export function describeOffline(
  client: OfflineClientState,
  model: ModelDownloadState,
  session: TranslationSessionState,
  options: {
    readonly online: boolean;
    readonly now: number;
    readonly hasMemoryModel: boolean;
    readonly otherClientCount: number;
    readonly actionBusy?: boolean;
  },
): OfflineView {
  const allStatuses = [client.controller, client.active, client.waiting].filter(Boolean);
  const currentStatus = !client.cacheCleared && client.currentBuildId
    ? allStatuses.find(status => status?.buildId === client.currentBuildId && isCompleteAssetStatus(status))
    : undefined;
  const appAssetsComplete = Boolean(currentStatus);
  const controlledByCurrentBuild = Boolean(
    client.registered && !client.cacheCleared && client.currentBuildId &&
    client.controller?.buildId === client.currentBuildId && isCompleteAssetStatus(client.controller),
  );
  const waitingUpdateIncomplete = Boolean(client.waiting && !isCompleteAssetStatus(client.waiting));
  const updateAvailable = Boolean(
    client.waiting && !waitingUpdateIncomplete && client.controller && client.waiting.buildId !== client.controller.buildId,
  );
  const updateActivatedForPage = Boolean(
    client.registered && client.active && client.currentBuildId &&
    client.active.buildId !== client.currentBuildId,
  );
  const needsInitialReload = client.registered && !updateAvailable &&
    (updateActivatedForPage || (appAssetsComplete && !controlledByCurrentBuild));
  const modelPhaseBusy = ACTIVE_DOWNLOAD_PHASES.has(model.phase);
  const modelError = model.phase === 'error';
  const hasValidOpfsModel = Boolean(
    !modelPhaseBusy && !modelError && model.storageMode === 'opfs' &&
    model.cache.available && model.cache.cached && model.cache.expiresAt !== undefined &&
    model.cache.expiresAt > options.now,
  );
  const ready = client.registered && controlledByCurrentBuild && hasValidOpfsModel;
  const sessionReason = sessionBusyReason(session);
  const busyReason = sessionReason || modelBusyReason(model) ||
    (client.phase === 'preparing' ? 'このアプリの保存データを保存中です。完了までお待ちください。' : '') ||
    (options.actionBusy ? 'オフライン設定を更新中です。完了までお待ちください。' : '');
  const busy = Boolean(busyReason);
  const clearDisabledReason = busyReason || (options.otherClientCount > 0
    ? '別のタブでこのアプリが開いています。ほかのタブを閉じてから削除してください。'
    : !client.registered
      ? '削除できるアプリデータがありません。'
      : '');
  const clientError = client.error?.message;
  const appStatusError = client.controllerError || (client.registered && !client.active && client.activeError);
  let status: string;
  let summary: string;
  let help = '';

  if (client.phase === 'unsupported') {
    status = client.error?.message ?? 'この環境ではオフライン利用を準備できません。';
    summary = 'この環境ではオフライン利用を準備できません。';
  } else if (client.phase === 'checking' || model.phase === 'checking') {
    status = 'ブラウザーとモデルの保存状態を確認しています。';
    summary = 'オフライン利用の状態を確認しています。';
  } else if (client.phase === 'preparing') {
    status = 'このアプリの保存データを保存しています。';
    summary = 'オフライン利用を準備しています。';
    help = 'モデルの取得は別の操作です。このアプリの保存データだけを準備し、モデルは自動取得・ロードしません。';
  } else if (clientError && !client.controller && !client.active) {
    status = clientError;
    summary = 'オフライン状態を確認できません。';
    help = 'アプリの保存状態を確認できませんでした。再試行できます。';
  } else if (modelError) {
    status = 'モデルの保存状態を確認できません。モデル設定を開いて状態を確認してください。';
    summary = 'モデルの状態を確認してください。';
  } else if (model.storageMode === 'memory') {
    status = options.hasMemoryModel
      ? 'モデルはこのページのメモリだけにあります。再読み込み後も使うには、オンラインでブラウザー保存を選んで取得してください。'
      : 'モデルはメモリだけに保存する設定です。再読み込み後も使うには、オンラインでブラウザー保存を選んで取得してください。';
    summary = 'メモリだけのモデルは次回のオフライン利用に使えません。';
    if (!appAssetsComplete) help = 'このアプリの保存データもまだ準備できていません。';
  } else if (model.cache.cached && model.cache.expiresAt !== undefined && model.cache.expiresAt <= options.now) {
    status = '保存モデルの保持期限が切れています。モデル設定から再取得してください。';
    summary = '保存モデルの期限が切れています。';
  } else if (model.phase === 'downloading' || model.phase === 'verifying' || model.phase === 'cancelling' ||
      model.phase === 'clearing' || model.phase === 'updating-retention') {
    status = modelBusyReason(model);
    summary = 'モデルの処理が終わるまでお待ちください。';
  } else if (!model.cache.available) {
    status = 'このブラウザーではモデルを保存できません。モデル設定で対応状況を確認してください。';
    summary = 'モデルをブラウザーに保存できません。';
  } else if (!model.cache.cached || !model.cache.expiresAt) {
    status = 'モデルがブラウザーに保存されていません。モデル設定から取得してください。';
    summary = 'このアプリの保存データとモデルの準備が必要です。';
  } else if (appStatusError) {
    status = appStatusError;
    summary = 'このアプリの保存状態を確認できません。';
    help = 'アプリの保存状態を確認できませんでした。再試行できます。';
  } else if (client.cacheCleared || !appAssetsComplete) {
    status = 'このアプリの保存データはまだありません。接続できるときに「オフライン利用を準備」を選んでください。';
    summary = 'オフライン利用の準備が必要です。';
    if (model.cache.cached) help = 'モデルはブラウザーに保存されています。このアプリの保存データを準備すると、再読み込み後に確認できます。';
  } else if (appAssetsComplete && !client.registered) {
    status = 'このアプリの保存状態を確認できません。オンラインで「オフライン利用を準備」を選んでください。';
    summary = 'オフライン利用の再準備が必要です。';
  } else if (updateActivatedForPage) {
    status = '更新を適用しました。再読み込みすると新しい版で開きます。';
    summary = ready ? '新しいアプリ版があります。再読み込みしてください。' : 'アプリの更新を適用しました。再読み込みしてください。';
  } else if (needsInitialReload) {
    status = updateActivatedForPage
      ? '更新を適用しました。再読み込みすると新しい版で開きます。'
      : 'このアプリの保存データを保存しました。再読み込みすると準備が完了します。';
    summary = updateActivatedForPage
      ? 'アプリの更新を適用しました。再読み込みしてください。'
      : 'このアプリの保存データは保存済みです。再読み込みが必要です。';
  } else if (!controlledByCurrentBuild) {
    status = 'このページにアプリの更新を適用してください。';
    summary = 'アプリの更新を適用してください。';
  } else if (ready) {
    status = options.online
      ? 'オフライン利用の準備が完了しています。このアプリの保存データと期限内のモデルを確認しました。'
      : 'オフラインで利用中です。このアプリの保存データと期限内のモデルを確認しました。';
    summary = options.online ? 'オフライン利用の準備が完了しています。' : 'オフライン利用中です。';
  } else {
    status = 'オフライン利用の準備状況を確認できません。モデル設定を開いて確認してください。';
    summary = 'オフライン利用の準備状況を確認してください。';
  }

  if (!options.online && client.phase !== 'unsupported' && !ready) {
    help = [help, 'ブラウザーはオフラインと表示しています。'].filter(Boolean).join(' ');
  }
  if (updateAvailable) {
    help = [help, '新しいアプリ版があります。更新は再読み込みを確認してから適用します。'].filter(Boolean).join(' ');
    if (ready) summary = `${summary} 新しいアプリ版があります。`;
  } else if (client.waitingError) {
    help = [help, '更新の確認に失敗しました。現在の保存状態はこのまま確認できます。'].filter(Boolean).join(' ');
  } else if (waitingUpdateIncomplete) {
    help = [help, '新しいアプリ版の保存状態を確認できません。現在の版は利用できます。更新版を修復してから適用できます。'].filter(Boolean).join(' ');
  }
  if (model.cache.cached && model.cache.expiresAt !== undefined && model.cache.expiresAt > options.now && !ready) {
    const expiry = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(model.cache.expiresAt);
    help = [help, `モデルの保持期限: ${expiry}。`].filter(Boolean).join(' ');
  }

  const showPrepare = client.phase !== 'unsupported' && (!ready || needsInitialReload) && client.error?.code !== 'scope-conflict' &&
    !controlledByCurrentBuild && !updateAvailable &&
    (!appAssetsComplete || needsInitialReload || !client.registered || client.cacheCleared || Boolean(client.error));
  const canPrepare = showPrepare && !busy;
  const canRetry = client.phase === 'error' || Boolean(client.error) || Boolean(client.waitingError) || waitingUpdateIncomplete;
  const canClear = client.registered && !busy && options.otherClientCount === 0;

  return {
    summary,
    status,
    help,
    ready,
    appAssetsComplete,
    controlledByCurrentBuild,
    updateAvailable,
    waitingUpdateIncomplete,
    needsInitialReload,
    busy,
    busyReason,
    canPrepare,
    showPrepare,
    prepareLabel: needsInitialReload
      ? updateActivatedForPage ? '更新を反映して再読み込み' : hasValidOpfsModel ? '再読み込みして準備を完了' : '保存したアプリで開き直す'
      : 'オフライン利用を準備',
    reloadLabel: updateActivatedForPage
      ? '更新を反映して再読み込み'
      : hasValidOpfsModel ? '再読み込みして準備を完了' : '保存したアプリで開き直す',
    canRetry,
    canClear,
    clearDisabledReason,
  };
}

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Offline UI element not found: ${id}`);
  return result as T;
}

function setTextIfChanged(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function isOnline(): boolean {
  return globalThis.navigator?.onLine !== false;
}

function formatError(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export function mountOffline(
  client: OfflineClient,
  downloader: OfflineModelPort,
  session: OfflineSessionPort,
  options: { readonly now?: () => number; readonly reload?: () => void } = {},
): () => void {
  const uiDocument = globalThis.document;
  const summary = element('offline-summary');
  const status = element('offline-status');
  const help = element('offline-help');
  const prepare = element<HTMLButtonElement>('offline-prepare');
  const retry = element<HTMLButtonElement>('offline-retry');
  const openModel = element<HTMLButtonElement>('offline-open-model');
  const disabledReason = element('offline-disabled-reason');
  const error = element<HTMLParagraphElement>('offline-error');
  const reloadConfirmation = element<HTMLDivElement>('offline-reload-confirmation');
  const reloadConfirm = element<HTMLButtonElement>('offline-reload-confirm');
  const reloadCancel = element<HTMLButtonElement>('offline-reload-cancel');
  const update = element<HTMLButtonElement>('offline-update');
  const updateDisabledReason = element('offline-update-disabled-reason');
  const updateConfirmation = element<HTMLDivElement>('offline-update-confirmation');
  const updateConfirm = element<HTMLButtonElement>('offline-update-confirm');
  const updateCancel = element<HTMLButtonElement>('offline-update-cancel');
  const clear = element<HTMLButtonElement>('offline-clear');
  const clearDisabledReason = element('offline-clear-disabled-reason');
  const clearConfirmation = element<HTMLDivElement>('offline-clear-confirmation');
  const clearConfirm = element<HTMLButtonElement>('offline-clear-confirm');
  const clearCancel = element<HTMLButtonElement>('offline-clear-cancel');
  const modelSettings = element<HTMLDetailsElement>('model-settings');
  const workspace = element<HTMLElement>('workspace');
  const preparationBanner = element<HTMLElement>('preparation-banner');
  const modelDownload = element<HTMLButtonElement>('model-download');
  let actionBusy = false;
  let controlError = '';
  let lastFailedAction: 'prepare' | 'refresh' | 'clear' | undefined;
  let reloadConfirmationOpen = false;
  let updateConfirmationOpen = false;
  let clearConfirmationOpen = false;
  let otherClientCount = 0;
  let expiryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let pageInteractionLocked = false;
  let restoreInteractionState: Array<{ element: HTMLElement; inert: boolean; ariaBusy: string | null }> = [];
  const now = options.now ?? (() => Date.now());
  const reloadPage = options.reload ?? (() => globalThis.location?.reload());

  const setPageInteractionLock = (locked: boolean) => {
    if (pageInteractionLocked === locked) return;
    pageInteractionLocked = locked;
    const regions = [workspace, modelSettings, preparationBanner];
    if (locked) {
      restoreInteractionState = regions.map(region => ({
        element: region,
        inert: region.inert === true,
        ariaBusy: region.getAttribute('aria-busy'),
      }));
      for (const region of regions) {
        region.inert = true;
        region.setAttribute('aria-busy', 'true');
      }
    } else {
      for (const previous of restoreInteractionState) {
        previous.element.inert = previous.inert;
        if (previous.ariaBusy === null) previous.element.removeAttribute('aria-busy');
        else previous.element.setAttribute('aria-busy', previous.ariaBusy);
      }
      restoreInteractionState = [];
    }
  };

  const currentOperationBusyReason = () =>
    sessionBusyReason(session.getState()) || modelBusyReason(downloader.getState());

  const closeReloadConfirmation = (returnFocus: boolean) => {
    if (!reloadConfirmationOpen) return;
    reloadConfirmationOpen = false;
    reloadConfirmation.hidden = true;
    if (returnFocus) prepare.focus();
    else status.focus();
  };
  const closeUpdateConfirmation = (returnFocus: boolean) => {
    if (!updateConfirmationOpen) return;
    updateConfirmationOpen = false;
    updateConfirmation.hidden = true;
    update.setAttribute('aria-expanded', 'false');
    if (returnFocus) update.focus();
    else status.focus();
  };
  const closeClearConfirmation = (returnFocus: boolean) => {
    if (!clearConfirmationOpen) return;
    clearConfirmationOpen = false;
    clearConfirmation.hidden = true;
    clear.setAttribute('aria-expanded', 'false');
    if (returnFocus) clear.focus();
    else status.focus();
  };

  const render = () => {
    const view = describeOffline(client.getState(), downloader.getState(), session.getState(), {
      online: isOnline(),
      now: now(),
      hasMemoryModel: downloader.hasMemoryModel(),
      otherClientCount,
      actionBusy,
    });
    setTextIfChanged(summary, view.summary);
    setTextIfChanged(status, view.status);
    setTextIfChanged(help, view.help);
    prepare.hidden = !view.showPrepare;
    prepare.disabled = !view.canPrepare;
    prepare.textContent = view.prepareLabel;
    retry.hidden = !view.canRetry;
    retry.disabled = actionBusy || view.busy;
    retry.textContent = view.waitingUpdateIncomplete ? '更新版を修復して再試行' : '再試行';
    openModel.disabled = actionBusy;
    setTextIfChanged(disabledReason, view.busy ? view.busyReason : '');
    disabledReason.hidden = !view.busy || !view.showPrepare;
    const errorMessage = controlError || client.getState().error?.message || '';
    error.hidden = !errorMessage;
    setTextIfChanged(error, errorMessage);

    reloadConfirmation.hidden = !reloadConfirmationOpen;
    reloadConfirm.textContent = view.reloadLabel;
    reloadConfirm.disabled = view.busy || actionBusy;
    update.hidden = !view.updateAvailable;
    update.disabled = view.busy || actionBusy;
    update.setAttribute('aria-expanded', String(updateConfirmationOpen));
    updateConfirmation.hidden = !updateConfirmationOpen;
    updateConfirm.disabled = view.busy || actionBusy;
    setTextIfChanged(updateDisabledReason, view.busy ? view.busyReason : '');
    updateDisabledReason.hidden = !view.updateAvailable || !view.busy;

    clear.disabled = !view.canClear;
    clear.setAttribute('aria-expanded', String(clearConfirmationOpen));
    clearConfirmation.hidden = !clearConfirmationOpen;
    clearConfirm.disabled = !view.canClear;
    setTextIfChanged(clearDisabledReason, view.clearDisabledReason);
    clearDisabledReason.hidden = !view.clearDisabledReason;

    if (view.busy || actionBusy) {
      if (reloadConfirmationOpen) reloadConfirm.disabled = true;
      if (updateConfirmationOpen) updateConfirm.disabled = true;
      if (clearConfirmationOpen) clearConfirm.disabled = true;
    }
    scheduleExpiryRender();
  };

  const scheduleExpiryRender = () => {
    if (expiryTimer !== undefined) globalThis.clearTimeout(expiryTimer);
    const expiresAt = downloader.getState().cache.expiresAt;
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return;
    const remaining = expiresAt - now();
    if (remaining <= 0) return;
    expiryTimer = globalThis.setTimeout(render, Math.min(remaining + 1, 60_000));
  };

  const updatePeerCount = async () => {
    try {
      otherClientCount = await client.countOtherClients();
    } catch {
      // The service worker performs its own client check before deleting anything.
    }
    render();
  };

  const performPrepare = async () => {
    const view = describeOffline(client.getState(), downloader.getState(), session.getState(), {
      online: isOnline(), now: now(), hasMemoryModel: downloader.hasMemoryModel(), otherClientCount,
    });
    if (actionBusy || view.busy || !view.canPrepare) return;
    if (view.needsInitialReload) {
      reloadConfirmationOpen = true;
      reloadConfirmation.hidden = false;
      reloadCancel.focus();
      return;
    }
    actionBusy = true;
    controlError = '';
    lastFailedAction = undefined;
    render();
    try {
      await client.prepare();
      const view = describeOffline(client.getState(), downloader.getState(), session.getState(), {
        online: isOnline(), now: now(), hasMemoryModel: downloader.hasMemoryModel(), otherClientCount,
      });
      if (view.needsInitialReload) {
        reloadConfirmationOpen = true;
        reloadConfirmation.hidden = false;
        reloadCancel.focus();
      }
    } catch (cause) {
      controlError = formatError(cause, 'オフライン利用を準備できませんでした。再試行してください。');
      lastFailedAction = 'prepare';
      error.focus();
    } finally {
      actionBusy = false;
      render();
    }
  };

  const performUpdate = async () => {
    if (actionBusy) return;
    const view = describeOffline(client.getState(), downloader.getState(), session.getState(), {
      online: isOnline(), now: now(), hasMemoryModel: downloader.hasMemoryModel(), otherClientCount,
    });
    if (view.busy || !updateConfirmationOpen) return;
    actionBusy = true;
    setPageInteractionLock(true);
    controlError = '';
    updateConfirmationOpen = false;
    updateConfirmation.hidden = true;
    render();
    let pageWillReload = false;
    try {
      await client.activateUpdate();
      const busyReason = currentOperationBusyReason();
      if (busyReason) {
        controlError = busyReason;
        reloadConfirmationOpen = true;
        reloadConfirmation.hidden = false;
        reloadCancel.focus();
      } else {
        pageWillReload = true;
        reloadPage();
      }
    } catch (cause) {
      controlError = formatError(cause, '更新を適用できませんでした。再試行してください。');
      lastFailedAction = 'refresh';
      error.focus();
    } finally {
      actionBusy = false;
      if (!pageWillReload) setPageInteractionLock(false);
      render();
    }
  };

  const performClear = async () => {
    if (actionBusy || !clearConfirmationOpen) return;
    const view = describeOffline(client.getState(), downloader.getState(), session.getState(), {
      online: isOnline(), now: now(), hasMemoryModel: downloader.hasMemoryModel(), otherClientCount,
    });
    if (view.busy || !view.canClear) return;
    actionBusy = true;
    setPageInteractionLock(true);
    controlError = '';
    clearConfirmationOpen = false;
    clearConfirmation.hidden = true;
    clear.setAttribute('aria-expanded', 'false');
    render();
    try {
      await client.clearAppCache();
      clear.focus();
    } catch (cause) {
      controlError = formatError(cause, 'アプリデータを削除できませんでした。再試行してください。');
      lastFailedAction = 'clear';
      error.focus();
    } finally {
      actionBusy = false;
      setPageInteractionLock(false);
      render();
    }
  };

  const onPageRefresh = () => {
    void client.refresh();
    void updatePeerCount();
    render();
  };
  const onVisibilityChange = () => {
    if (uiDocument.visibilityState === 'visible') onPageRefresh();
  };

  const unsubscribeClient = client.subscribe(render);
  const unsubscribeModel = downloader.subscribe(render);
  const unsubscribeSession = session.subscribe(render);
  const windowTarget = globalThis.window;
  windowTarget?.addEventListener('pageshow', onPageRefresh);
  windowTarget?.addEventListener('focus', onPageRefresh);
  windowTarget?.addEventListener('online', render);
  windowTarget?.addEventListener('offline', render);
    uiDocument.addEventListener?.('visibilitychange', onVisibilityChange);

  prepare.addEventListener('click', () => { void performPrepare(); });
  retry.addEventListener('click', () => {
    if (lastFailedAction === 'prepare') {
      void performPrepare();
    } else if (lastFailedAction === 'clear') {
      clearConfirmationOpen = true;
      clearConfirmation.hidden = false;
      clearCancel.focus();
    } else if (describeOffline(client.getState(), downloader.getState(), session.getState(), {
      online: isOnline(), now: now(), hasMemoryModel: downloader.hasMemoryModel(), otherClientCount,
    }).waitingUpdateIncomplete) {
      controlError = '';
      lastFailedAction = 'refresh';
      actionBusy = true;
      render();
      void client.repairWaitingUpdate().catch(cause => {
        controlError = formatError(cause, '更新版を準備できませんでした。現在の版は利用できます。');
        error.focus();
      }).finally(() => {
        actionBusy = false;
        render();
      });
    } else {
      controlError = '';
      lastFailedAction = 'refresh';
      void client.refresh().catch(cause => {
        controlError = formatError(cause, '状態を確認できませんでした。');
        error.focus();
      }).finally(render);
    }
  });
  openModel.addEventListener('click', () => {
    modelSettings.open = true;
    globalThis.requestAnimationFrame?.(() => {
      modelDownload.focus();
      modelDownload.scrollIntoView?.({ block: 'nearest' });
    });
  });
  reloadConfirm.addEventListener('click', () => {
    const view = describeOffline(client.getState(), downloader.getState(), session.getState(), {
      online: isOnline(), now: now(), hasMemoryModel: downloader.hasMemoryModel(), otherClientCount,
    });
    const busyReason = currentOperationBusyReason();
    if (view.busy || busyReason || actionBusy || !reloadConfirmationOpen) {
      if (busyReason) {
        controlError = busyReason;
        render();
        error.focus();
      }
      return;
    }
    closeReloadConfirmation(false);
    actionBusy = true;
    setPageInteractionLock(true);
    render();
    reloadPage();
  });
  reloadCancel.addEventListener('click', () => closeReloadConfirmation(true));
  update.addEventListener('click', () => {
    const view = describeOffline(client.getState(), downloader.getState(), session.getState(), {
      online: isOnline(), now: now(), hasMemoryModel: downloader.hasMemoryModel(), otherClientCount,
    });
    if (view.busy || actionBusy || !view.updateAvailable) return;
    updateConfirmationOpen = true;
    updateConfirmation.hidden = false;
    update.setAttribute('aria-expanded', 'true');
    updateCancel.focus();
  });
  updateConfirm.addEventListener('click', () => { void performUpdate(); });
  updateCancel.addEventListener('click', () => closeUpdateConfirmation(true));
  clear.addEventListener('click', () => {
    const view = describeOffline(client.getState(), downloader.getState(), session.getState(), {
      online: isOnline(), now: now(), hasMemoryModel: downloader.hasMemoryModel(), otherClientCount,
    });
    if (!view.canClear || actionBusy) return;
    clearConfirmationOpen = true;
    clearConfirmation.hidden = false;
    clear.setAttribute('aria-expanded', 'true');
    clearCancel.focus();
  });
  clearConfirm.addEventListener('click', () => { void performClear(); });
  clearCancel.addEventListener('click', () => closeClearConfirmation(true));

  void client.initialize().catch(cause => {
    controlError = formatError(cause, 'オフライン状態を確認できませんでした。再試行してください。');
    lastFailedAction = 'refresh';
    render();
  });
  void updatePeerCount();
  render();

  return () => {
    unsubscribeClient();
    unsubscribeModel();
    unsubscribeSession();
    if (expiryTimer !== undefined) globalThis.clearTimeout(expiryTimer);
    windowTarget?.removeEventListener('pageshow', onPageRefresh);
    windowTarget?.removeEventListener('focus', onPageRefresh);
    windowTarget?.removeEventListener('online', render);
    windowTarget?.removeEventListener('offline', render);
    uiDocument.removeEventListener?.('visibilitychange', onVisibilityChange);
    client.dispose();
  };
}
