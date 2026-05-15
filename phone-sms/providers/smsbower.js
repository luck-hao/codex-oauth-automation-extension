// phone-sms/providers/smsbower.js — smsbower.app 接码平台适配层
(function attachSmsbowerProvider(root, factory) {
  root.PhoneSmsBowerProvider = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createSmsbowerProviderModule() {
  const PROVIDER_ID = 'smsbower';
  const DEFAULT_BASE_URL = 'https://smsbower.page/stubs/handler_api.php';
  const DEFAULT_SERVICE_CODE = 'dr';
  const DEFAULT_SERVICE_LABEL = 'OpenAI';
  const DEFAULT_COUNTRY_ID = 6;
  const DEFAULT_COUNTRY_LABEL = 'Indonesia';
  const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
  const DEFAULT_MAX_USES = 3;

  function normalizeSmsbowerCountryId(value, fallback = DEFAULT_COUNTRY_ID) {
    const parsed = Math.floor(Number(value));
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    const fallbackParsed = Math.floor(Number(fallback));
    if (Number.isFinite(fallbackParsed)) return fallbackParsed;
    return DEFAULT_COUNTRY_ID;
  }

  function normalizeSmsbowerCountryLabel(value = '', fallback = DEFAULT_COUNTRY_LABEL) {
    return String(value || '').trim() || fallback;
  }

  function normalizeSmsbowerServiceCode(value = '', fallback = DEFAULT_SERVICE_CODE) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    if (normalized) return normalized;
    const fallbackNormalized = String(fallback || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    return fallbackNormalized || DEFAULT_SERVICE_CODE;
  }

  function normalizeSmsbowerMaxPrice(value = '') {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) return '';
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    return String(Math.round(numeric * 10000) / 10000);
  }

  function normalizeSmsbowerCountryOrder(value = []) {
    const source = Array.isArray(value)
      ? value
      : String(value || '')
        .split(/[\r\n,，;；]+/)
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
    const normalized = [];
    const seen = new Set();
    source.forEach((entry) => {
      let id = 0;
      let label = '';
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        id = normalizeSmsbowerCountryId(entry.id ?? entry.countryId ?? entry.country, -1);
        label = String((entry.label ?? entry.countryLabel ?? entry.name) || '').trim();
      } else {
        const text = String(entry || '').trim();
        const structured = text.match(/^(\d+)\s*(?:[:|/-]\s*(.+))?$/);
        id = normalizeSmsbowerCountryId(structured?.[1] || text, -1);
        label = String(structured?.[2] || '').trim();
      }
      if (id < 0 || seen.has(id)) return;
      seen.add(id);
      normalized.push({ id, label: label || `Country #${id}` });
    });
    return normalized.slice(0, 20);
  }

  function normalizeBaseUrl(value = '') {
    const trimmed = String(value || '').trim() || DEFAULT_BASE_URL;
    try {
      return new URL(trimmed).toString();
    } catch {
      return DEFAULT_BASE_URL;
    }
  }

  function buildUrl(config = {}, query = {}) {
    const url = new URL(normalizeBaseUrl(config.baseUrl));
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  function parsePayload(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.parse(trimmed); } catch { return trimmed; }
    }
    return trimmed;
  }

  function describePayload(raw) {
    if (typeof raw === 'string') return raw.trim();
    if (raw && typeof raw === 'object') {
      const direct = String(raw.message || raw.msg || raw.error || raw.title || raw.status || '').trim();
      if (direct) return direct;
      try { return JSON.stringify(raw); } catch { return String(raw); }
    }
    return String(raw || '').trim();
  }

  function resolveConfig(state = {}, deps = {}) {
    return {
      apiKey: String(state.smsbowerApiKey || state.heroSmsApiKey || '').trim(),
      baseUrl: state.smsbowerBaseUrl || DEFAULT_BASE_URL,
      serviceCode: normalizeSmsbowerServiceCode(state.smsbowerServiceCode, DEFAULT_SERVICE_CODE),
      maxPrice: normalizeSmsbowerMaxPrice(state.smsbowerMaxPrice),
      fetchImpl: deps.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
      requestTimeoutMs: deps.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  async function fetchPayload(config, query, actionLabel = 'smsbower request') {
    if (query.api_key === undefined && config.apiKey) {
      query = { api_key: config.apiKey, ...query };
    }
    if (!config.fetchImpl) {
      throw new Error('smsbower fetch implementation is unavailable.');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), Number(config.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS)
      : null;
    try {
      const response = await config.fetchImpl(buildUrl(config, query), {
        method: 'GET',
        signal: controller?.signal,
      });
      const text = await response.text();
      const payload = parsePayload(text);
      if (!response.ok) {
        const error = new Error(`${actionLabel} failed: ${describePayload(payload) || response.status}`);
        error.payload = payload;
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${actionLabel} timed out.`);
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function assertApiKey(config) {
    if (!config.apiKey) {
      throw new Error('smsbower API key is missing. Save it in the side panel before running the phone flow.');
    }
  }

  function resolveCountryConfig(state = {}) {
    const ordered = normalizeSmsbowerCountryOrder(state.smsbowerCountryOrder);
    if (ordered.length) {
      return ordered[0];
    }
    const primaryId = normalizeSmsbowerCountryId(state.smsbowerCountryId, -1);
    if (primaryId >= 0) {
      return {
        id: primaryId,
        label: normalizeSmsbowerCountryLabel(state.smsbowerCountryLabel, `Country #${primaryId}`),
      };
    }
    return {
      id: DEFAULT_COUNTRY_ID,
      label: DEFAULT_COUNTRY_LABEL,
    };
  }

  function resolveCountryCandidates(state = {}) {
    const hasConfiguredOrder = Array.isArray(state.smsbowerCountryOrder)
      ? state.smsbowerCountryOrder.length > 0
      : String(state.smsbowerCountryOrder || '').trim().length > 0;
    const ordered = normalizeSmsbowerCountryOrder(
      hasConfiguredOrder ? state.smsbowerCountryOrder : state.countryCandidates
    );
    const primaryId = hasConfiguredOrder ? -1 : normalizeSmsbowerCountryId(state.smsbowerCountryId, -1);
    const primary = primaryId >= 0
      ? {
        id: primaryId,
        label: normalizeSmsbowerCountryLabel(state.smsbowerCountryLabel, `Country #${primaryId}`),
      }
      : null;
    const fallback = hasConfiguredOrder || ordered.length ? null : { id: DEFAULT_COUNTRY_ID, label: DEFAULT_COUNTRY_LABEL };
    const candidates = [];
    const seen = new Set();
    [...ordered, primary, fallback].forEach((entry) => {
      const isObjectEntry = entry && typeof entry === 'object' && !Array.isArray(entry);
      const id = normalizeSmsbowerCountryId(
        isObjectEntry ? (entry.id ?? entry.countryId ?? entry.country) : entry,
        -1
      );
      if (id < 0 || seen.has(id)) return;
      seen.add(id);
      const label = isObjectEntry
        ? (entry.label ?? entry.countryLabel ?? entry.name)
        : '';
      candidates.push({ id, label: normalizeSmsbowerCountryLabel(label, `Country #${id}`) });
    });
    return candidates;
  }

  function normalizeActivation(record, fallback = {}) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const activationId = String(record.activationId ?? record.id ?? '').trim();
    const phoneNumber = String(record.phoneNumber ?? record.phone ?? record.number ?? '').trim();
    if (!activationId || !phoneNumber) return null;
    const countryId = normalizeSmsbowerCountryId(record.countryId ?? record.country ?? fallback.countryId, DEFAULT_COUNTRY_ID);
    const countryLabel = normalizeSmsbowerCountryLabel(record.countryLabel || fallback.countryLabel, `Country #${countryId}`);
    return {
      activationId,
      phoneNumber,
      provider: PROVIDER_ID,
      serviceCode: normalizeSmsbowerServiceCode(record.serviceCode || fallback.serviceCode, DEFAULT_SERVICE_CODE),
      countryId,
      countryLabel,
      successfulUses: Math.max(0, Math.floor(Number(record.successfulUses) || 0)),
      maxUses: Math.max(1, Math.floor(Number(record.maxUses) || DEFAULT_MAX_USES)),
      ...(record.status ? { status: String(record.status) } : {}),
      ...(record.raw ? { raw: record.raw } : {}),
    };
  }

  function parseActivationPayload(payload, fallback = {}) {
    const direct = normalizeActivation(payload, fallback);
    if (direct) return direct;
    const text = describePayload(payload);
    const match = text.match(/^ACCESS_NUMBER:([^:]+):(.+)$/i);
    if (!match) return null;
    const countryId = normalizeSmsbowerCountryId(fallback.countryId, DEFAULT_COUNTRY_ID);
    return {
      activationId: String(match[1] || '').trim(),
      phoneNumber: String(match[2] || '').trim(),
      provider: PROVIDER_ID,
      serviceCode: normalizeSmsbowerServiceCode(fallback.serviceCode, DEFAULT_SERVICE_CODE),
      countryId,
      countryLabel: normalizeSmsbowerCountryLabel(fallback.countryLabel, `Country #${countryId}`),
      successfulUses: 0,
      maxUses: DEFAULT_MAX_USES,
      raw: payload,
    };
  }

  function classifyFailure(payloadOrMessage) {
    const text = describePayload(payloadOrMessage);
    if (/\bBAD_KEY\b|\bINVALID_KEY\b|\bWRONG_KEY\b/i.test(text)) return 'bad-key';
    if (/\bNO_BALANCE\b|\bNOT_ENOUGH_BALANCE\b/i.test(text)) return 'no-balance';
    if (/\bNO_NUMBERS\b|\bNO_NUMBER\b|no\s+numbers?/i.test(text)) return 'no-numbers';
    if (/\bNO_ACTIVATION\b|activation\s+not\s+found/i.test(text)) return 'no-activation';
    if (/rate\s*limit|too\s*many\s*requests|429/i.test(text)) return 'rate-limit';
    return '';
  }

  function isRetryableAcquireFailure(payloadOrMessage) {
    const kind = classifyFailure(payloadOrMessage);
    return kind === 'no-numbers' || kind === 'rate-limit';
  }

  function isTerminalAcquireFailure(payloadOrMessage) {
    const kind = classifyFailure(payloadOrMessage);
    return kind === 'bad-key' || kind === 'no-balance';
  }

  function extractVerificationCode(rawCodeOrText) {
    const trimmed = String(rawCodeOrText || '').trim();
    if (!trimmed) return '';
    const match = trimmed.match(/\b(\d{4,8})\b/);
    return match?.[1] || trimmed;
  }

  async function fetchBalance(state = {}, deps = {}) {
    const config = resolveConfig(state, deps);
    assertApiKey(config);
    const payload = await fetchPayload(config, { action: 'getBalance' }, 'smsbower getBalance');
    const text = describePayload(payload);
    const balance = Number(text.replace(/^ACCESS_BALANCE:/i, '').trim());
    return { balance, raw: payload };
  }

  async function fetchCountries(state = {}, deps = {}) {
    const config = resolveConfig(state, deps);
    const payload = await fetchPayload(config, { action: 'getCountries' }, 'smsbower getCountries');
    if (Array.isArray(payload)) {
      return payload.map((entry) => ({
        id: normalizeSmsbowerCountryId(entry.id ?? entry.country ?? entry.countryId, -1),
        label: normalizeSmsbowerCountryLabel(entry.name || entry.label, ''),
      })).filter((entry) => entry.id >= 0);
    }
    if (payload && typeof payload === 'object') {
      return Object.entries(payload).map(([id, value]) => ({
        id: normalizeSmsbowerCountryId(id, -1),
        label: normalizeSmsbowerCountryLabel(value?.name || value?.label || value, `Country #${id}`),
      })).filter((entry) => entry.id >= 0);
    }
    return [];
  }

  async function fetchPrices(state = {}, countryConfig = resolveCountryConfig(state), deps = {}) {
    const config = resolveConfig(state, deps);
    return fetchPayload(config, {
      action: 'getPrices',
      service: config.serviceCode,
      country: normalizeSmsbowerCountryId(countryConfig?.id),
    }, 'smsbower getPrices');
  }

  function collectPriceEntries(payload, entries = []) {
    if (Array.isArray(payload)) {
      payload.forEach((entry) => collectPriceEntries(entry, entries));
      return entries;
    }
    if (!payload || typeof payload !== 'object') return entries;
    const cost = Number(payload.cost ?? payload.price ?? payload.Price);
    const count = Number(payload.count ?? payload.qty ?? payload.Qty ?? payload.available);
    if (Number.isFinite(cost)) {
      entries.push({
        cost,
        count: Number.isFinite(count) ? count : 0,
        inStock: !Number.isFinite(count) || count > 0,
      });
    }
    Object.values(payload).forEach((value) => collectPriceEntries(value, entries));
    return entries;
  }

  async function resolveLowestAvailableMaxPrice(config, countryConfig) {
    if (config.maxPrice) {
      return config.maxPrice;
    }
    try {
      const payload = await fetchPayload(config, {
        action: 'getPrices',
        service: config.serviceCode,
        country: normalizeSmsbowerCountryId(countryConfig?.id),
      }, 'smsbower getPrices');
      const entries = collectPriceEntries(payload)
        .filter((entry) => entry.inStock && Number.isFinite(entry.cost) && entry.cost > 0)
        .sort((left, right) => left.cost - right.cost);
      return entries.length ? normalizeSmsbowerMaxPrice(entries[0].cost) : '';
    } catch {
      return '';
    }
  }

  async function requestActivation(state = {}, options = {}, deps = {}) {
    const config = resolveConfig(state, deps);
    assertApiKey(config);
    const allCountryCandidates = resolveCountryCandidates(state);
    const blockedCountryIds = new Set(
      (Array.isArray(options?.blockedCountryIds) ? options.blockedCountryIds : [])
        .map((value) => normalizeSmsbowerCountryId(value, -1))
        .filter((id) => id >= 0)
    );
    let countryCandidates = allCountryCandidates.filter((entry) => !blockedCountryIds.has(normalizeSmsbowerCountryId(entry.id, -1)));
    if (!countryCandidates.length) countryCandidates = allCountryCandidates;
    if (!countryCandidates.length) {
      throw new Error('smsbower countries are empty. Please select at least one country in 接码设置。');
    }

    const noNumbersByCountry = [];
    let lastError = null;
    let lastFailureText = '';
    for (const countryConfig of countryCandidates) {
      const countryId = normalizeSmsbowerCountryId(countryConfig.id);
      const countryLabel = normalizeSmsbowerCountryLabel(countryConfig.label, `Country #${countryId}`);
      try {
        const maxPrice = await resolveLowestAvailableMaxPrice(config, { id: countryId, label: countryLabel });
        const payload = await fetchPayload(config, {
          action: 'getNumber',
          service: config.serviceCode,
          country: countryId,
          maxPrice,
        }, 'smsbower getNumber');
        const activation = parseActivationPayload(payload, {
          countryId,
          countryLabel,
          serviceCode: config.serviceCode,
        });
        if (activation) return activation;
        lastFailureText = describePayload(payload) || 'empty response';
        if (isTerminalAcquireFailure(payload)) {
          throw new Error(`smsbower 获取手机号失败：${lastFailureText}`);
        }
        noNumbersByCountry.push(`${countryLabel}: ${lastFailureText}`);
      } catch (error) {
        const payloadOrMessage = error?.payload || error?.message;
        const failureText = describePayload(payloadOrMessage) || lastFailureText || 'unknown error';
        if (isTerminalAcquireFailure(payloadOrMessage)) {
          throw new Error(`smsbower 获取手机号失败：${failureText}`);
        }
        if (isRetryableAcquireFailure(payloadOrMessage)) {
          lastFailureText = failureText;
          noNumbersByCountry.push(`${countryLabel}: ${failureText}`);
          continue;
        }
        lastError = error;
        lastFailureText = failureText;
      }
    }
    if (noNumbersByCountry.length) {
      throw new Error(`smsbower no numbers available across ${countryCandidates.length} country candidate(s): ${noNumbersByCountry.join(' | ')}.`);
    }
    if (lastError) throw lastError;
    throw new Error(`smsbower 获取手机号失败，最后状态：${lastFailureText || '未知'}。`);
  }

  async function setActivationStatus(state = {}, activation, status, actionLabel, deps = {}) {
    const normalizedActivation = normalizeActivation(activation);
    if (!normalizedActivation) return '';
    const config = resolveConfig(state, deps);
    assertApiKey(config);
    const payload = await fetchPayload(config, {
      action: 'setStatus',
      id: normalizedActivation.activationId,
      status,
    }, actionLabel);
    return describePayload(payload);
  }

  async function finishActivation(state = {}, activation, deps = {}) {
    return setActivationStatus(state, activation, 6, 'smsbower setStatus(6)', deps);
  }

  async function cancelActivation(state = {}, activation, deps = {}) {
    return setActivationStatus(state, activation, 8, 'smsbower setStatus(8)', deps);
  }

  async function banActivation(state = {}, activation, deps = {}) {
    return cancelActivation(state, activation, deps);
  }

  async function requestAdditionalSms(state = {}, activation, deps = {}) {
    return setActivationStatus(state, activation, 3, 'smsbower setStatus(3)', deps);
  }

  async function pollActivationCode(state = {}, activation, options = {}, deps = {}) {
    const normalizedActivation = normalizeActivation(activation);
    if (!normalizedActivation) {
      throw new Error('缺少手机号接码订单。');
    }
    const config = resolveConfig(state, deps);
    assertApiKey(config);
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 180000);
    const intervalMs = Math.max(1000, Number(options.intervalMs) || 5000);
    const maxRoundsRaw = Math.floor(Number(options.maxRounds));
    const maxRounds = Number.isFinite(maxRoundsRaw) && maxRoundsRaw > 0 ? maxRoundsRaw : 0;
    const start = Date.now();
    let pollCount = 0;
    let lastResponse = '';

    while (Date.now() - start < timeoutMs) {
      if (maxRounds > 0 && pollCount >= maxRounds) break;
      deps.throwIfStopped?.();
      const payload = await fetchPayload(config, {
        action: 'getStatus',
        id: normalizedActivation.activationId,
      }, 'smsbower getStatus');
      pollCount += 1;
      lastResponse = describePayload(payload);
      if (typeof options.onStatus === 'function') {
        await options.onStatus({
          activation: normalizedActivation,
          elapsedMs: Date.now() - start,
          pollCount,
          statusText: lastResponse || '未知',
          timeoutMs,
        });
      }
      const okMatch = lastResponse.match(/^STATUS_OK:(.+)$/i);
      if (okMatch) {
        const code = extractVerificationCode(okMatch[1]);
        if (code) return code;
      }
      if (/^STATUS_CANCEL\b/i.test(lastResponse)) {
        throw new Error('smsbower 查询验证码失败：订单已取消。');
      }
      if (/\bNO_ACTIVATION\b/i.test(lastResponse)) {
        throw new Error('smsbower 查询验证码失败：订单不存在。');
      }
      if (typeof options.onWaitingForCode === 'function') {
        await options.onWaitingForCode({
          activation: normalizedActivation,
          elapsedMs: Date.now() - start,
          pollCount,
          statusText: lastResponse || '未知',
          timeoutMs,
        });
      }
      await deps.sleepWithStop?.(intervalMs);
    }

    const suffix = lastResponse ? ` smsbower 最后状态：${lastResponse}` : '';
    throw new Error(`PHONE_CODE_TIMEOUT::等待手机验证码超时。${suffix}`);
  }

  function createProvider(deps = {}) {
    const providerDeps = {
      fetchImpl: deps.fetchImpl,
      sleepWithStop: deps.sleepWithStop,
      throwIfStopped: deps.throwIfStopped,
      addLog: deps.addLog,
      requestTimeoutMs: deps.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
    };
    return {
      id: PROVIDER_ID,
      label: 'smsbower.app',
      defaultCountryId: DEFAULT_COUNTRY_ID,
      defaultCountryLabel: DEFAULT_COUNTRY_LABEL,
      defaultProduct: DEFAULT_SERVICE_LABEL,
      defaultServiceCode: DEFAULT_SERVICE_CODE,
      normalizeCountryId: normalizeSmsbowerCountryId,
      normalizeCountryLabel: normalizeSmsbowerCountryLabel,
      normalizeCountryOrder: normalizeSmsbowerCountryOrder,
      normalizeCountryFallback: normalizeSmsbowerCountryOrder,
      normalizeServiceCode: normalizeSmsbowerServiceCode,
      normalizeMaxPrice: normalizeSmsbowerMaxPrice,
      resolveCountryCandidates,
      requestActivation: (state, options) => requestActivation(state, options, providerDeps),
      finishActivation: (state, activation) => finishActivation(state, activation, providerDeps),
      cancelActivation: (state, activation) => cancelActivation(state, activation, providerDeps),
      banActivation: (state, activation) => banActivation(state, activation, providerDeps),
      requestAdditionalSms: (state, activation) => requestAdditionalSms(state, activation, providerDeps),
      pollActivationCode: (state, activation, options) => pollActivationCode(state, activation, options, providerDeps),
      fetchBalance: (state) => fetchBalance(state, providerDeps),
      fetchCountries: (state) => fetchCountries(state, providerDeps),
      fetchPrices: (state, countryConfig) => fetchPrices(state, countryConfig, providerDeps),
      collectPriceEntries,
      describePayload,
    };
  }

  return {
    PROVIDER_ID,
    DEFAULT_BASE_URL,
    DEFAULT_COUNTRY_ID,
    DEFAULT_COUNTRY_LABEL,
    DEFAULT_SERVICE_CODE,
    DEFAULT_SERVICE_LABEL,
    createProvider,
    describePayload,
    normalizeSmsbowerCountryId,
    normalizeSmsbowerCountryLabel,
    normalizeSmsbowerCountryOrder,
    normalizeSmsbowerServiceCode,
    normalizeSmsbowerMaxPrice,
  };
});
