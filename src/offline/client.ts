export interface OfflineAssetStatus {
  readonly buildId: string;
  readonly complete: boolean;
  readonly resourceCount: number;
  readonly totalBytes: number;
  readonly missing?: readonly string[];
}

export type OfflineClientPhase =
  | 'checking'
  | 'unsupported'
  | 'unprepared'
  | 'preparing'
  | 'available'
  | 'error';

export interface OfflineClientState {
  readonly phase: OfflineClientPhase;
  readonly supported: boolean;
  readonly currentBuildId: string | null;
  readonly registered: boolean;
  readonly cacheCleared: boolean;
  readonly controller?: OfflineAssetStatus;
  readonly active?: OfflineAssetStatus;
  readonly waiting?: OfflineAssetStatus;
  readonly controllerError?: string;
  readonly activeError?: string;
  readonly waitingError?: string;
  readonly error?: Readonly<{ code: string; message: string }>;
}

export interface OfflineClientEnvironment {
  readonly serviceWorker?: ServiceWorkerContainer;
  readonly document?: Document;
  readonly location?: Location;
  readonly secureContext: boolean;
  readonly development: boolean;
  readonly baseUrl: string;
  readonly BroadcastChannel?: typeof BroadcastChannel;
}

interface WorkerStatusReply {
  readonly type: 'STATUS';
  readonly protocolVersion: number;
  readonly requestId: string;
  readonly requestType: 'GET_STATUS';
  readonly pageBuildId: string;
  readonly targetBuildId: null;
  readonly buildId: string;
  readonly complete: boolean;
  readonly resourceCount: number;
  readonly totalBytes: number;
  readonly missing?: readonly string[];
}

interface WorkerResultReply {
  readonly type: 'RESULT';
  readonly protocolVersion: number;
  readonly requestId: string;
  readonly requestType: 'ACTIVATE_UPDATE' | 'CLEAR_APP_CACHE' | 'PREPARE_APP_CACHE';
  readonly pageBuildId: string;
  readonly targetBuildId: string;
  readonly buildId: string;
  readonly ok: boolean;
  readonly reason?: string;
  readonly complete?: boolean;
  readonly resourceCount?: number;
  readonly totalBytes?: number;
  readonly missing?: readonly string[];
}

type WorkerReply = WorkerStatusReply | WorkerResultReply;

interface OfflineClientOptions {
  readonly timeoutMs?: number;
  readonly prepareTimeoutMs?: number;
  readonly peerResponseMs?: number;
}

const CHANNEL_NAME = 'local-web-translation-offline-clients';
const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_PREPARE_TIMEOUT_MS = 180_000;
const DEFAULT_PEER_RESPONSE_MS = 160;

function browserEnvironment(): OfflineClientEnvironment {
  const browserLocation = globalThis.location;
  const baseUrl = import.meta.env?.BASE_URL ?? '/';
  const serviceWorker = globalThis.navigator?.serviceWorker;
  const document = globalThis.document;
  return {
    serviceWorker,
    document,
    location: browserLocation,
    secureContext: globalThis.isSecureContext === true,
    development: import.meta.env?.DEV === true,
    baseUrl,
    BroadcastChannel: globalThis.BroadcastChannel,
  };
}

function buildIdFromEnvironment(environment: OfflineClientEnvironment): string | null {
  const value = environment.document?.querySelector<HTMLMetaElement>('meta[name="offline-build"]')?.content.trim();
  return value || null;
}

function unsupportedMessage(environment: OfflineClientEnvironment): string | undefined {
  if (environment.location?.protocol === 'file:') {
    return 'オフライン利用には HTTPS で公開されたページが必要です。';
  }
  if (environment.development) {
    return '開発用ページではオフライン保存を利用できません。公開版を開いてください。';
  }
  if (!environment.secureContext) {
    return 'オフライン利用には HTTPS（または localhost）で開いたページが必要です。';
  }
  if (!environment.serviceWorker) {
    return 'このブラウザーではオフライン保存を利用できません。';
  }
  if (!buildIdFromEnvironment(environment)) {
    return 'このアプリの版を確認できません。公開版を開き直してください。';
  }
  return undefined;
}

function isAssetStatus(value: unknown): value is WorkerStatusReply {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WorkerStatusReply>;
  return candidate.type === 'STATUS' &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    typeof candidate.requestId === 'string' &&
    candidate.requestType === 'GET_STATUS' &&
    typeof candidate.pageBuildId === 'string' &&
    candidate.targetBuildId === null &&
    typeof candidate.buildId === 'string' && candidate.buildId.length > 0 &&
    typeof candidate.complete === 'boolean' &&
    Number.isSafeInteger(candidate.resourceCount) && candidate.resourceCount! >= 0 &&
    Number.isSafeInteger(candidate.totalBytes) && candidate.totalBytes! >= 0 &&
    (candidate.missing === undefined || Array.isArray(candidate.missing));
}

function isResultReply(value: unknown): value is WorkerResultReply {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WorkerResultReply>;
  return candidate.type === 'RESULT' && typeof candidate.requestType === 'string' &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.pageBuildId === 'string' &&
    typeof candidate.targetBuildId === 'string' &&
    typeof candidate.buildId === 'string' &&
    typeof candidate.ok === 'boolean';
}

function wait<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new OfflineClientError('timeout', message)), timeoutMs);
    promise.then(value => {
      globalThis.clearTimeout(timer);
      resolve(value);
    }, error => {
      globalThis.clearTimeout(timer);
      reject(error);
    });
  });
}

function fulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === 'fulfilled';
}

function rejected<T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult {
  return result.status === 'rejected';
}

function rejectedMessage<T>(result: PromiseSettledResult<T>): string | undefined {
  if (!rejected(result)) return undefined;
  return result.reason instanceof Error ? result.reason.message : 'アプリの保存状態を確認できませんでした。';
}

let requestSequence = 0;

function workerRequest(
  worker: ServiceWorker,
  request: Record<string, unknown> & { type: string; pageBuildId: string; targetBuildId: string | null },
  timeoutMs: number,
): Promise<WorkerReply> {
  if (typeof MessageChannel === 'undefined') {
    return Promise.reject(new OfflineClientError('unsupported', 'このブラウザーではオフライン状態を確認できません。'));
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const requestId = `${Date.now()}-${++requestSequence}`;
    const message = { ...request, requestId, protocolVersion: PROTOCOL_VERSION };
    const timer = globalThis.setTimeout(() => {
      channel.port1.close();
      reject(new OfflineClientError('timeout', 'オフライン状態の確認に時間がかかっています。再試行してください。'));
    }, timeoutMs);

    channel.port1.onmessage = event => {
      globalThis.clearTimeout(timer);
      channel.port1.close();
      const reply = event.data as unknown;
      if (!isAssetStatus(reply) && !isResultReply(reply)) {
        reject(new OfflineClientError('invalid-response', 'アプリの保存状態を確認できませんでした。'));
        return;
      }
      if (reply.requestId !== requestId || reply.requestType !== request.type ||
          reply.pageBuildId !== request.pageBuildId || reply.targetBuildId !== request.targetBuildId ||
          (typeof request.targetBuildId === 'string' && reply.buildId !== request.targetBuildId)) {
        reject(new OfflineClientError('stale-response', '別の要求に対する応答を受け取りました。もう一度お試しください。'));
        return;
      }
      resolve(reply);
    };
    channel.port1.onmessageerror = () => {
      globalThis.clearTimeout(timer);
      channel.port1.close();
      reject(new OfflineClientError('invalid-response', 'アプリの保存状態を読み取れませんでした。'));
    };

    try {
      worker.postMessage(message, [channel.port2]);
    } catch (cause) {
      globalThis.clearTimeout(timer);
      channel.port1.close();
      reject(new OfflineClientError('post-message', 'アプリの保存状態を確認できません。再試行してください。', cause));
    }
  });
}

export class OfflineClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: unknown) {
    super(message, options === undefined ? undefined : { cause: options });
    this.name = 'OfflineClientError';
    this.code = code;
  }
}

/** Reads and manages only this app's service-worker cache. It never registers during startup. */
export class OfflineClient {
  private readonly environment: OfflineClientEnvironment;
  private readonly timeoutMs: number;
  private readonly prepareTimeoutMs: number;
  private readonly peerResponseMs: number;
  private readonly listeners = new Set<(state: OfflineClientState) => void>();
  private readonly watchedWorkers = new Set<ServiceWorker>();
  private readonly watchedRegistrations = new Set<ServiceWorkerRegistration>();
  private latestInstallingWorker?: ServiceWorker;
  private state: OfflineClientState;
  private registration?: ServiceWorkerRegistration;
  private scopeConflict = false;
  private preparing = false;
  private cacheCleared = false;
  private refreshPending = false;
  private channel?: BroadcastChannel;
  private readonly clientId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

  constructor(environment: OfflineClientEnvironment = browserEnvironment(), options: OfflineClientOptions = {}) {
    this.environment = environment;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
    this.peerResponseMs = options.peerResponseMs ?? DEFAULT_PEER_RESPONSE_MS;
    const reason = unsupportedMessage(environment);
    this.state = Object.freeze({
      phase: reason ? 'unsupported' : 'checking',
      supported: !reason,
      currentBuildId: buildIdFromEnvironment(environment),
      registered: false,
      cacheCleared: false,
      error: reason ? Object.freeze({ code: 'unsupported', message: reason }) : undefined,
    });
    this.connectPeerChannel();
    environment.serviceWorker?.addEventListener('controllerchange', this.handleWorkerChange);
  }

  getState(): OfflineClientState {
    return this.state;
  }

  subscribe(listener: (state: OfflineClientState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.environment.serviceWorker?.removeEventListener('controllerchange', this.handleWorkerChange);
    for (const registration of this.watchedRegistrations) {
      registration.removeEventListener('updatefound', this.handleWorkerChange);
    }
    for (const worker of this.watchedWorkers) {
      worker.removeEventListener('statechange', this.handleWorkerChange);
    }
    this.channel?.close();
    this.listeners.clear();
  }

  async initialize(): Promise<void> {
    if (!this.state.supported) return;
    await this.refresh();
    if (this.environment.location && this.environment.serviceWorker && this.registration && globalThis.navigator?.onLine !== false) {
      // Ask the browser to look for a newer worker. This never activates or reloads it.
      void this.getExistingRegistration()
        .then(registration => registration
          ? wait(registration.update(), this.timeoutMs, '更新の確認がタイムアウトしました。')
          : undefined)
        .then(() => undefined)
        .then(() => this.refresh())
        .catch(() => {});
    }
  }

  async refresh(): Promise<void> {
    if (!this.state.supported || !this.environment.serviceWorker) return;
    if (this.refreshPending) return;
    this.refreshPending = true;
    try {
      this.registration = await this.getExistingRegistration();
      this.watchRegistration(this.registration);
      const controller = this.appController();
      const active = this.registration?.active;
      const waiting = this.registration?.waiting;
      const [controllerResult, activeResult, waitingResult] = await Promise.allSettled([
        this.readStatus(controller),
        active === controller ? Promise.resolve(undefined) : this.readStatus(active),
        waiting === controller || waiting === active ? Promise.resolve(undefined) : this.readStatus(waiting),
      ]);
      const controllerStatus = fulfilled(controllerResult) ? controllerResult.value : undefined;
      const activeStatus = fulfilled(activeResult) ? activeResult.value : undefined;
      const waitingStatus = fulfilled(waitingResult) ? waitingResult.value : undefined;
      const nextPhase: OfflineClientPhase = this.preparing
        ? 'preparing'
        : this.scopeConflict
          ? 'error'
          : this.registration
          ? 'available'
          : 'unprepared';
      this.publish({
        phase: this.cacheCleared ? 'unprepared' : nextPhase,
        supported: true,
        currentBuildId: this.state.currentBuildId,
        registered: Boolean(this.registration),
        cacheCleared: this.cacheCleared,
        controller: controllerStatus,
        active: active === controller ? controllerStatus : activeStatus,
        waiting: waiting === controller ? controllerStatus : waiting === active ? activeStatus : waitingStatus,
        controllerError: rejectedMessage(controllerResult),
        activeError: rejectedMessage(activeResult),
        waitingError: rejectedMessage(waitingResult),
        error: controller && rejected(controllerResult)
          ? Object.freeze({ code: 'controller-status', message: rejectedMessage(controllerResult)! })
          : this.scopeConflict
            ? Object.freeze({ code: 'scope-conflict', message: 'このアプリ専用の保存設定を確認できません。ページを開き直して再試行してください。' })
          : undefined,
      });
    } catch (cause) {
      const error = this.toError(cause);
      this.publish({
        ...this.state,
        phase: this.preparing ? 'preparing' : 'error',
        error: Object.freeze({ code: error.code, message: error.message }),
      });
    } finally {
      this.refreshPending = false;
    }
  }

  /** Called only from the explicit offline preparation action. */
  async prepare(): Promise<void> {
    this.assertSupported();
    if (this.preparing) return;
    this.preparing = true;
    this.cacheCleared = false;
    this.publish({ ...this.state, phase: 'preparing', cacheCleared: false, error: undefined });
    try {
      const serviceWorker = this.environment.serviceWorker!;
      this.registration = await this.getExistingRegistration();
      if (!this.registration && this.scopeConflict) {
        throw new OfflineClientError('scope-conflict', 'このアプリ専用の保存設定を確認できません。ページを開き直して再試行してください。');
      }
      if (!this.registration) {
        this.registration = await wait(
          serviceWorker.register(this.workerUrl(), { scope: this.scopeUrl() }),
          this.prepareTimeoutMs,
          'アプリの保存準備がタイムアウトしました。もう一度お試しください。',
        );
      }
      if (!this.ownsRegistration(this.registration)) {
        this.registration = undefined;
        throw new OfflineClientError('foreign-registration', 'このアプリ専用の保存設定を確認できません。ページを開き直して再試行してください。');
      }
      this.watchRegistration(this.registration);

      let statuses = await this.readRegistrationStatuses();
      let currentWorker = this.findCurrentBuildWorker(statuses);
      if (!currentWorker || !currentWorker.status.complete) {
        if (!this.registration.installing && !this.registration.waiting) {
          await wait(
            this.registration.update(),
            this.timeoutMs,
            'アプリの更新確認がタイムアウトしました。接続を確認して再試行してください。',
          );
          this.watchRegistration(this.registration);
        }
        await this.waitForCurrentBuildWorker();
        statuses = await this.readRegistrationStatuses();
        currentWorker = this.findCurrentBuildWorker(statuses);
      }

      if (currentWorker && !currentWorker.status.complete) {
        await this.prepareWorkerCache(currentWorker.worker);
      }
      await this.refresh();
    } catch (cause) {
      const error = this.toError(cause);
      this.publish({
        ...this.state,
        phase: 'error',
        error: Object.freeze({ code: error.code, message: error.message }),
      });
      throw error;
    } finally {
      this.preparing = false;
      if (this.state.phase === 'preparing') {
        this.publish({ ...this.state, phase: this.registration ? 'available' : 'unprepared' });
      }
      await this.refresh();
    }
  }

  async activateUpdate(): Promise<void> {
    this.registration = await this.getExistingRegistration();
    const waitingWorker = this.registration?.waiting;
    if (!waitingWorker) throw new OfflineClientError('not-waiting', '適用できる更新はありません。');
    const status = await this.readStatus(waitingWorker);
    if (!status || !status.complete || status.resourceCount <= 0 || status.totalBytes <= 0) {
      throw new OfflineClientError('incomplete-update', '更新版の保存状態を確認できません。現在の版を使い続け、再試行してください。');
    }
    if (this.registration?.waiting !== waitingWorker) {
      throw new OfflineClientError('stale-update', '更新の状態が変わりました。再試行してください。');
    }
    const reply = await workerRequest(waitingWorker, {
      type: 'ACTIVATE_UPDATE',
      pageBuildId: this.state.currentBuildId!,
      targetBuildId: status.buildId,
    }, this.timeoutMs);
    if (!isResultReply(reply) || reply.requestType !== 'ACTIVATE_UPDATE') {
      throw new OfflineClientError('invalid-response', '更新の準備状況を確認できませんでした。');
    }
    if (!reply.ok) throw this.workerError(reply.reason, '更新を適用できませんでした。');
    await this.waitForActiveBuild(status.buildId);
  }

  async repairWaitingUpdate(): Promise<void> {
    this.assertSupported();
    this.registration = await this.getExistingRegistration();
    const waitingWorker = this.registration?.waiting;
    if (!waitingWorker) throw new OfflineClientError('not-waiting', '修復する更新はありません。');
    const status = await this.readStatus(waitingWorker);
    if (!status) throw new OfflineClientError('invalid-response', '更新版の保存状態を確認できません。');
    if (status.complete) return;
    if (this.registration?.waiting !== waitingWorker) {
      throw new OfflineClientError('stale-update', '更新の状態が変わりました。再試行してください。');
    }
    const reply = await workerRequest(waitingWorker, {
      type: 'PREPARE_APP_CACHE',
      pageBuildId: this.state.currentBuildId!,
      targetBuildId: status.buildId,
    }, this.prepareTimeoutMs);
    if (!isResultReply(reply) || reply.requestType !== 'PREPARE_APP_CACHE') {
      throw new OfflineClientError('invalid-response', '更新版の修復結果を確認できません。');
    }
    if (!reply.ok) throw this.workerError(reply.reason, '更新版を準備できませんでした。現在の版は利用できます。');
    if (!reply.complete || reply.buildId !== status.buildId) {
      throw new OfflineClientError('incomplete-update', '更新版の保存を確認できません。現在の版は利用できます。');
    }
    await this.refresh();
  }

  async clearAppCache(): Promise<void> {
    this.assertSupported();
    this.registration = await this.getExistingRegistration();
    if (!this.registration?.active) throw new OfflineClientError('unprepared', '削除するアプリデータがありません。');
    const otherClients = await this.countOtherClients();
    if (otherClients > 0) {
      throw new OfflineClientError('multiple-clients', '別のタブでこのアプリが開いています。ほかのタブを閉じてから削除してください。');
    }
    const activeStatus = await this.readStatus(this.registration.active);
    if (!activeStatus) throw new OfflineClientError('unprepared', '削除するアプリデータがありません。');
    const reply = await workerRequest(this.registration.active, {
      type: 'CLEAR_APP_CACHE',
      pageBuildId: this.state.currentBuildId!,
      targetBuildId: activeStatus.buildId,
    }, this.timeoutMs);
    if (!isResultReply(reply) || reply.requestType !== 'CLEAR_APP_CACHE') {
      throw new OfflineClientError('invalid-response', 'アプリデータの削除結果を確認できませんでした。');
    }
    if (!reply.ok) throw this.workerError(reply.reason, 'アプリデータを削除できませんでした。');
    this.cacheCleared = true;
    this.registration = undefined;
    this.publish({
      ...this.state,
      phase: 'unprepared',
      registered: false,
      cacheCleared: true,
      active: undefined,
      waiting: undefined,
      error: undefined,
    });
  }

  async countOtherClients(): Promise<number> {
    const Channel = this.environment.BroadcastChannel;
    if (!Channel) return 0;
      const channel = new Channel(this.peerChannelName());
    const requestId = `${this.clientId}-${Date.now()}`;
    const clients = new Set<string>();
    return new Promise<number>(resolve => {
      const finish = () => {
        channel.close();
        resolve(clients.size);
      };
      channel.onmessage = event => {
        const data = event.data as { type?: string; requestId?: string; clientId?: string };
        if (data.type === 'CLIENT_PROBE_RESPONSE' && data.requestId === requestId && data.clientId !== this.clientId) {
          clients.add(data.clientId ?? 'unknown');
        }
      };
      channel.postMessage({ type: 'CLIENT_PROBE', requestId, clientId: this.clientId });
      globalThis.setTimeout(finish, this.peerResponseMs);
    });
  }

  private readonly handleWorkerChange = (): void => { void this.refresh(); };

  private connectPeerChannel(): void {
    const Channel = this.environment.BroadcastChannel;
    if (!Channel) return;
    try {
      this.channel = new Channel(this.peerChannelName());
      this.channel.onmessage = event => {
        const data = event.data as { type?: string; requestId?: string; clientId?: string };
        if (data.type === 'CLIENT_PROBE' && data.clientId !== this.clientId) {
          this.channel?.postMessage({
            type: 'CLIENT_PROBE_RESPONSE',
            requestId: data.requestId,
            clientId: this.clientId,
          });
        }
      };
    } catch {
      this.channel = undefined;
    }
  }

  private watchRegistration(registration?: ServiceWorkerRegistration): void {
    if (!registration) return;
    if (!this.watchedRegistrations.has(registration)) {
      this.watchedRegistrations.add(registration);
      registration.addEventListener('updatefound', this.handleWorkerChange);
    }
    if (registration.installing) this.latestInstallingWorker = registration.installing;
    this.watchWorker(registration.installing);
    this.watchWorker(registration.waiting);
    this.watchWorker(registration.active);
  }

  private watchWorker(worker: ServiceWorker | null): void {
    if (!worker || this.watchedWorkers.has(worker)) return;
    this.watchedWorkers.add(worker);
    worker.addEventListener('statechange', this.handleWorkerChange);
  }

  private appController(): ServiceWorker | null {
    const controller = this.environment.serviceWorker?.controller ?? null;
    if (!controller || !this.isExactUrl(controller.scriptURL, this.workerUrl())) return null;
    return controller;
  }

  private async readStatus(worker: ServiceWorker | null | undefined): Promise<OfflineAssetStatus | undefined> {
    if (!worker || worker.state === 'redundant') return undefined;
    if (!this.isExactUrl(worker.scriptURL, this.workerUrl())) return undefined;
    const reply = await workerRequest(worker, {
      type: 'GET_STATUS',
      pageBuildId: this.state.currentBuildId!,
      targetBuildId: null,
    }, this.timeoutMs);
    if (!isAssetStatus(reply)) throw new OfflineClientError('invalid-response', 'アプリ保存状態の応答が不正です。');
    return {
      buildId: reply.buildId,
      complete: reply.complete,
      resourceCount: reply.resourceCount,
      totalBytes: reply.totalBytes,
      missing: reply.missing,
    };
  }

  private async readRegistrationStatuses(): Promise<Array<{ worker: ServiceWorker; status: OfflineAssetStatus }>> {
    const workers = [this.registration?.active, this.registration?.waiting, this.registration?.installing]
      .filter((worker): worker is ServiceWorker => Boolean(worker));
    const uniqueWorkers = [...new Set(workers)];
    const results = await Promise.allSettled(uniqueWorkers.map(async worker => ({
      worker,
      status: await this.readStatus(worker),
    })));
    return results
      .filter(fulfilled)
      .map(result => result.value)
      .filter((item): item is { worker: ServiceWorker; status: OfflineAssetStatus } => Boolean(item.status));
  }

  private findCurrentBuildWorker(
    statuses: readonly { worker: ServiceWorker; status: OfflineAssetStatus }[],
  ): { worker: ServiceWorker; status: OfflineAssetStatus } | undefined {
    const currentBuildId = this.state.currentBuildId;
    if (!currentBuildId) return undefined;
    return statuses.find(item => item.status.buildId === currentBuildId);
  }

  private async prepareWorkerCache(worker: ServiceWorker): Promise<void> {
    const status = await this.readStatus(worker);
    if (!status || status.buildId !== this.state.currentBuildId) {
      throw new OfflineClientError('build-mismatch', '現在のアプリ版に対応する保存先を確認できませんでした。');
    }
    if (status.complete) return;
    const reply = await workerRequest(worker, {
      type: 'PREPARE_APP_CACHE',
      targetBuildId: status.buildId,
      pageBuildId: this.state.currentBuildId!,
    }, this.prepareTimeoutMs);
    if (!isResultReply(reply) || reply.requestType !== 'PREPARE_APP_CACHE') {
      throw new OfflineClientError('invalid-response', 'アプリデータの保存結果を確認できませんでした。');
    }
    if (!reply.ok) throw this.workerError(reply.reason, 'アプリデータを保存できませんでした。');
    if (reply.targetBuildId !== this.state.currentBuildId || reply.complete !== true) {
      throw new OfflineClientError('incomplete-cache', 'すべてのアプリデータを確認できませんでした。再試行してください。');
    }
  }

  private async waitForCurrentBuildWorker(): Promise<void> {
    const startedAt = Date.now();
    let targetWorker: ServiceWorker | null = null;
    while (Date.now() - startedAt < this.prepareTimeoutMs) {
      this.registration = await this.getExistingRegistration();
      if (!this.registration && this.scopeConflict) {
        throw new OfflineClientError('scope-conflict', 'このアプリ専用の保存設定を確認できません。ページを開き直して再試行してください。');
      }
      this.watchRegistration(this.registration);
      const statuses = await this.readRegistrationStatuses().catch(() => []);
      const match = this.findCurrentBuildWorker(statuses);
      if (match && (match.worker.state === 'installed' || match.worker.state === 'activating' || match.worker.state === 'activated')) return;
      targetWorker = this.latestInstallingWorker ?? null;
      if (targetWorker?.state === 'redundant') {
        throw new OfflineClientError('install-failed', 'アプリの保存準備に失敗しました。もう一度お試しください。');
      }
      await new Promise(resolve => globalThis.setTimeout(resolve, 120));
    }
    throw new OfflineClientError('timeout', 'アプリ本体の保存がタイムアウトしました。接続を確認して再試行してください。');
  }

  private async waitForActiveBuild(buildId: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.timeoutMs) {
      await this.refresh();
      if (this.state.active?.buildId === buildId && this.registration?.active?.state === 'activated') return;
      await new Promise(resolve => globalThis.setTimeout(resolve, 100));
    }
    throw new OfflineClientError('timeout', '新しいアプリ版の準備を確認できません。状態を確認して再試行してください。');
  }

  private workerError(reason: string | undefined, fallback: string): OfflineClientError {
    switch (reason) {
      case 'multiple-clients':
        return new OfflineClientError(reason, 'ほかのタブでこのアプリが開いています。ほかのタブを閉じてから再試行してください。');
      case 'invalid-client':
        return new OfflineClientError(reason, 'このページからアプリデータを操作できません。公開版を開き直してください。');
      case 'not-waiting':
        return new OfflineClientError(reason, '適用できる更新がありません。状態を確認して再試行してください。');
      case 'activation-failed':
        return new OfflineClientError(reason, '更新を開始できませんでした。再試行してください。');
      case 'cache-error':
        return new OfflineClientError(reason, 'アプリデータを削除できませんでした。再試行してください。');
      case 'incomplete-cache':
      case 'precache-failed':
        return new OfflineClientError(reason, 'アプリの保存データを確認できません。現在の版はそのまま利用できます。');
      case 'build-mismatch':
        return new OfflineClientError(reason, 'アプリの版が一致しません。公開版を再読み込みしてから再試行してください。');
      default:
        return new OfflineClientError(reason ?? 'worker-error', fallback);
    }
  }

  private assertSupported(): void {
    if (!this.state.supported || !this.environment.serviceWorker) {
      throw new OfflineClientError('unsupported', this.state.error?.message ?? 'オフライン保存を利用できません。');
    }
  }

  private scopeUrl(): string {
    const location = this.environment.location;
    if (!location) throw new OfflineClientError('unsupported', 'ページの URL を確認できません。');
    return new URL(this.environment.baseUrl, location.href).href;
  }

  private workerUrl(): string {
    return new URL('service-worker.js', this.scopeUrl()).href;
  }

  private peerChannelName(): string {
    return `${CHANNEL_NAME}:${new URL(this.scopeUrl()).pathname}`;
  }

  private async getExistingRegistration(): Promise<ServiceWorkerRegistration | undefined> {
    const serviceWorker = this.environment.serviceWorker;
    if (!serviceWorker) return undefined;
    const registration = await wait(
      serviceWorker.getRegistration(this.scopeUrl()),
      this.timeoutMs,
      'アプリの保存状態を確認できません。再試行してください。',
    );
    if (!registration || !this.isExactUrl(registration.scope, this.scopeUrl())) {
      this.scopeConflict = false;
      return undefined;
    }
    if (!this.ownsRegistration(registration)) {
      this.scopeConflict = true;
      return undefined;
    }
    this.scopeConflict = false;
    return registration;
  }

  private ownsRegistration(registration: ServiceWorkerRegistration): boolean {
    if (!this.isExactUrl(registration.scope, this.scopeUrl())) return false;
    return [registration.active, registration.waiting, registration.installing]
      .filter((worker): worker is ServiceWorker => Boolean(worker))
      .every(worker => this.isExactUrl(worker.scriptURL, this.workerUrl()));
  }

  private isExactUrl(candidate: string, expected: string): boolean {
    try {
      return new URL(candidate).href === new URL(expected).href;
    } catch {
      return false;
    }
  }

  private toError(cause: unknown): OfflineClientError {
    return cause instanceof OfflineClientError
      ? cause
      : new OfflineClientError('service-worker', cause instanceof Error
        ? 'アプリの保存状態を確認できません。接続を確認して再試行してください。'
        : 'オフライン状態を確認できませんでした。再試行してください。', cause);
  }

  private publish(nextState: OfflineClientState): void {
    this.state = Object.freeze({ ...nextState });
    for (const listener of this.listeners) listener(this.state);
  }
}
