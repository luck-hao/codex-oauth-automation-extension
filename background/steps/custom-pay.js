;(function attachBackgroundCustomPay(root, factory) {
  root.MultiPageBackgroundCustomPay = factory()
})(
  typeof self !== 'undefined' ? self : globalThis,
  function createBackgroundCustomPayModule() {
    const CHATGPT_SOURCE = 'signup-page'
    const PLUS_CHECKOUT_SOURCE = 'plus-checkout'
    const CUSTOM_PAY_OTP_SOURCE = 'custom-pay-otp'
    const CUSTOM_PAY_METHOD = 'custom-pay'
    const OTP_CODE_TIMEOUT_MS = 60000
    const POLL_INTERVAL_MS = 800
    const CUSTOM_PAY_ASSIST_TIMEOUT_MS = 180000
    const CUSTOM_PAY_ASSIST_SETTLE_MS = 2000

    function createCustomPayExecutor(deps = {}) {
      const {
        addLog: rawAddLog = async () => {},
        broadcastDataUpdate,
        chrome,
        completeStepFromBackground,
        createAutomationTab = null,
        getTabId,
        isTabAlive,
        queryTabsInAutomationWindow = null,
        registerTab,
        setState,
        sleepWithStop,
        waitForTabCompleteUntilStopped = async () => {},
        throwIfStopped = () => {}
      } = deps

      function addLog(message, level = 'info', options = {}) {
        return rawAddLog(
          message,
          level,
          options && typeof options === 'object' ? options : {}
        )
      }

      function isChatGptUrl(url = '') {
        return /^https:\/\/chatgpt\.com(?:\/|$)/i.test(String(url || ''))
      }

      function isCustomPayReturnUrl(url = '') {
        return isChatGptUrl(url)
      }

      function isPayPalUrl(url = '') {
        return /paypal\./i.test(String(url || ''))
      }

      function normalizeHostedUrl(value = '') {
        const rawUrl = String(value || '').trim()
        if (!rawUrl) {
          return ''
        }
        try {
          const parsed = new URL(rawUrl)
          return parsed.protocol === 'https:' || parsed.protocol === 'http:'
            ? parsed.href
            : ''
        } catch {
          return ''
        }
      }

      function formatHostedLinkError(result = {}) {
        const message = String(result?.message || '').trim()
        const status = Number(result?.status) || 0
        const reason = String(result?.reason || '').trim()
        const parts = [message || '生成 Custom Pay 支付链接失败']
        if (status) {
          parts.push(`HTTP ${status}`)
        }
        if (reason) {
          parts.push(reason)
        }
        return parts.join('，')
      }

      function formatSafeUrlForLog(value = '') {
        const rawUrl = String(value || '').trim()
        if (!rawUrl) {
          return ''
        }
        try {
          const parsed = new URL(rawUrl)
          return `${parsed.host}${parsed.pathname || '/'}`
        } catch {
          return rawUrl.split(/[?#]/)[0].slice(0, 140)
        }
      }

      function sanitizeCustomPayLogText(value = '', limit = 120) {
        return String(value || '')
          .replace(/\s+/g, ' ')
          .replace(
            /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
            '[email]'
          )
          .replace(/\b\d{6,}\b/g, (match) => `[${match.length}位数字]`)
          .trim()
          .slice(0, limit)
      }

      function formatCustomPayStatusForLog(status = {}) {
        if (!status || typeof status !== 'object') {
          return 'status=空'
        }
        const page = formatSafeUrlForLog(
          status.url ||
            (status.host ? `https://${status.host}${status.path || ''}` : '')
        )
        const parts = []
        if (page) parts.push(`page=${page}`)
        if (status.readyState) parts.push(`ready=${status.readyState}`)
        if (Number.isInteger(status.frameId)) parts.push(`frame=${status.frameId}`)
        if (status.documentId) parts.push(`doc=${String(status.documentId).slice(0, 16)}`)
        parts.push(`sca=${status.hasScaMultiField ? 'yes' : 'no'}`)
        parts.push(`scaInputs=${Number(status.scaInputCount) || 0}`)
        parts.push(`otp=${status.hasOtpInput ? 'yes' : 'no'}`)
        parts.push(`otpInputs=${Number(status.otpInputCount) || 0}`)
        parts.push(`consent=${status.hasConsentButton ? 'yes' : 'no'}`)
        if (status.consentButtonText) {
          parts.push(
            `consentText=${sanitizeCustomPayLogText(status.consentButtonText, 60)}`
          )
        }
        parts.push(`complete=${status.looksComplete ? 'yes' : 'no'}`)
        if (status.bodyTextPreview) {
          parts.push(
            `preview=${sanitizeCustomPayLogText(status.bodyTextPreview, 120)}`
          )
        }
        return parts.join('，')
      }

      function formatCustomPayClickForLog(clickResult = {}) {
        if (!clickResult || typeof clickResult !== 'object') {
          return 'click=空'
        }
        const parts = [`click=${clickResult.clicked ? 'yes' : 'no'}`]
        if (clickResult.reason) parts.push(`reason=${clickResult.reason}`)
        if (clickResult.buttonText) {
          parts.push(
            `button=${sanitizeCustomPayLogText(clickResult.buttonText, 80)}`
          )
        }
        if (clickResult.buttonId) parts.push(`buttonId=${clickResult.buttonId}`)
        if (Number.isInteger(clickResult.frameId)) parts.push(`frame=${clickResult.frameId}`)
        return parts.join('，')
      }

      function formatCustomPayResultForLog(result = {}) {
        if (!result || typeof result !== 'object') {
          return 'result=空'
        }
        const parts = []
        if (result.kind) parts.push(`kind=${result.kind}`)
        const page = formatSafeUrlForLog(result.url || result.status?.url || '')
        if (page) parts.push(`page=${page}`)
        if (Number.isInteger(result.frameId)) parts.push(`frame=${result.frameId}`)
        if (result.documentId) parts.push(`doc=${String(result.documentId).slice(0, 16)}`)
        parts.push(`clicked=${result.clickedAssistButton ? 'yes' : 'no'}`)
        if (result.clickResult) parts.push(formatCustomPayClickForLog(result.clickResult))
        if (Array.isArray(result.logs) && result.logs.length) {
          parts.push(
            `scriptLogs=${result.logs
              .map((message) =>
                sanitizeCustomPayLogText(message, 100)
              )
              .filter(Boolean)
              .slice(-6)
              .join(' | ')}`
          )
        }
        return parts.join('，')
      }

      function maskOtpCodeForLog(code = '') {
        const value = String(code || '').trim()
        if (!value) return '空'
        return `${value.length}位:${'*'.repeat(Math.min(value.length, 8))}`
      }

      async function queryTabs(queryInfo = {}) {
        const query =
          typeof queryTabsInAutomationWindow === 'function'
            ? queryTabsInAutomationWindow
            : chrome?.tabs?.query?.bind(chrome.tabs)
        if (typeof query !== 'function') {
          return []
        }
        return query(queryInfo).catch(() => [])
      }

      async function getAliveRegisteredTabId(source) {
        const tabId =
          typeof getTabId === 'function' ? await getTabId(source) : 0
        if (!tabId) {
          return 0
        }
        if (typeof isTabAlive === 'function') {
          return (await isTabAlive(source)) ? Number(tabId) || 0 : 0
        }
        const tab = await chrome?.tabs?.get?.(tabId).catch(() => null)
        return tab?.id ? tab.id : 0
      }

      async function resolveChatGptTabId(state = {}) {
        const registeredTabId = await getAliveRegisteredTabId(CHATGPT_SOURCE)
        if (registeredTabId) {
          return registeredTabId
        }

        const storedCandidates = [
          state.customPayChatGptTabId,
          state.signupTabId,
          state.chatgptTabId
        ]
          .map((value) => Number(value) || 0)
          .filter(Boolean)
        for (const tabId of storedCandidates) {
          const tab = await chrome?.tabs?.get?.(tabId).catch(() => null)
          if (tab?.id && isChatGptUrl(tab.url || '')) {
            return tab.id
          }
        }

        const tabs = await queryTabs({})
        const candidates = tabs.filter(
          (tab) => Number.isInteger(tab?.id) && isChatGptUrl(tab.url || '')
        )
        const match =
          candidates.find((tab) => tab.active && tab.currentWindow) ||
          candidates.find((tab) => tab.active) ||
          candidates[0]
        if (match?.id) {
          return match.id
        }
        throw new Error('未找到 ChatGPT 页面，无法继续 Custom Pay 操作。')
      }

      async function resolvePaymentTabId(state = {}) {
        const registeredTabId =
          await getAliveRegisteredTabId(PLUS_CHECKOUT_SOURCE)
        if (registeredTabId) {
          return registeredTabId
        }

        const storedTabId = Number(state?.plusCheckoutTabId) || 0
        if (storedTabId) {
          const tab = await chrome?.tabs?.get?.(storedTabId).catch(() => null)
          if (tab?.id) {
            if (typeof registerTab === 'function') {
              await registerTab(PLUS_CHECKOUT_SOURCE, tab.id)
            }
            return tab.id
          }
        }

        const tabs = await queryTabs({})
        const match =
          tabs.find(
            (tab) => Number.isInteger(tab?.id) && isPayPalUrl(tab.url || '')
          ) ||
          tabs.find(
            (tab) =>
              Number.isInteger(tab?.id) &&
              /checkout|payment|billing|stripe/i.test(tab.url || '')
          )
        if (match?.id) {
          if (typeof registerTab === 'function') {
            await registerTab(PLUS_CHECKOUT_SOURCE, match.id)
          }
          return match.id
        }
        throw new Error('未找到 Custom Pay 支付页，请先打开支付链接。')
      }

      async function runScript(tabId, func, args = []) {
        if (!chrome?.scripting?.executeScript) {
          throw new Error('当前环境不支持页面脚本注入。')
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func,
          args
        })
        return results?.[0]?.result || null
      }

      function attachFrameMetadata(result, frameId, documentId = '') {
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          return result
        }
        return {
          ...result,
          frameId,
          documentId,
          status:
            result.status &&
            typeof result.status === 'object' &&
            !Array.isArray(result.status)
              ? {
                  ...result.status,
                  frameId,
                  documentId
                }
              : result.status
        }
      }

      async function runScriptInAllFrames(tabId, func, args = []) {
        if (!chrome?.scripting?.executeScript) {
          throw new Error('当前环境不支持页面脚本注入。')
        }
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func,
            args
          })
          return (Array.isArray(results) ? results : []).map((entry) => {
            const frameId = Number.isInteger(entry?.frameId) ? entry.frameId : -1
            const documentId = entry?.documentId || ''
            const result = entry?.result
            if (
              result &&
              typeof result === 'object' &&
              !Array.isArray(result)
            ) {
              return attachFrameMetadata(result, frameId, documentId)
            }
            return {
              kind: 'frame-result',
              result,
              frameId,
              documentId
            }
          })
        } catch (error) {
          const fallback = await runScript(tabId, func, args)
          if (
            fallback &&
            typeof fallback === 'object' &&
            !Array.isArray(fallback)
          ) {
            return [
              {
                ...attachFrameMetadata(fallback, 0),
                allFramesFallback: true
              }
            ]
          }
          return fallback
            ? [
                {
                  kind: 'frame-result',
                  result: fallback,
                  frameId: 0,
                  allFramesFallback: true
                }
              ]
            : []
        }
      }

      async function runScriptInFrame(tabId, frameId, func, args = []) {
        if (!chrome?.scripting?.executeScript) {
          throw new Error('当前环境不支持页面脚本注入。')
        }
        const target =
          Number.isInteger(frameId) && frameId >= 0
            ? { tabId, frameIds: [frameId] }
            : { tabId }
        const results = await chrome.scripting.executeScript({
          target,
          func,
          args
        })
        const entry = Array.isArray(results) ? results[0] : null
        const result = entry?.result
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const actualFrameId = Number.isInteger(entry?.frameId)
            ? entry.frameId
            : Number.isInteger(frameId)
              ? frameId
              : 0
          return attachFrameMetadata(
            result,
            actualFrameId,
            entry?.documentId || ''
          )
        }
        return result || null
      }

      function countFilledCheckoutFields(info = {}) {
        return [
          'emailFilled',
          'phoneFilled',
          'cardNumberFilled',
          'cardExpiryFilled',
          'cardCvvFilled',
          'passwordFilled',
          'firstNameFilled',
          'lastNameFilled',
          'line1Filled',
          'cityFilled',
          'postalFilled'
        ].filter((key) => info[key]).length
      }

      function countAttemptedCheckoutFields(info = {}) {
        const attempted =
          info?.attempted && typeof info.attempted === 'object'
            ? info.attempted
            : {}
        return Object.values(attempted).filter(Boolean).length
      }

      function scorePaymentAssistResult(result = {}) {
        const kind = String(result?.kind || '')
        const isMainCompleteResult =
          kind === 'complete' &&
          result?.frameId === 0 &&
          isCustomPayReturnUrl(result?.status?.url || result?.url || '')
        const kindScores = {
          complete: isMainCompleteResult ? 10000 : 100,
          'paypal-sca': 9500,
          'paypal-consent': 9000,
          'paypal-checkout': 8000,
          stripe: 7000,
          'paypal-login': 6500,
          generic: 1000,
          'frame-scan': 100
        }
        let score = kindScores[kind] || 0
        if (result?.clickedAssistButton || result?.clickResult?.clicked)
          score += 500
        if (String(result?.url || '').includes('/checkoutweb/')) score += 200
        if (result?.kind === 'paypal-checkout') {
          score += countFilledCheckoutFields(result.checkoutFormInfo) * 40
          score += countAttemptedCheckoutFields(result.checkoutFormInfo) * 5
          if (result.clickResult?.reason === 'form_not_filled') score += 20
        }
        if (result?.frameId === 0) score += 1
        return score
      }

      function selectPaymentAssistResult(results = []) {
        const candidates = (Array.isArray(results) ? results : []).filter(
          (result) => result && typeof result === 'object'
        )
        if (!candidates.length) {
          return null
        }
        return candidates.sort(
          (left, right) =>
            scorePaymentAssistResult(right) - scorePaymentAssistResult(left)
        )[0]
      }

      function isPayPalCheckoutFormInfoComplete(info = {}) {
        return Boolean(
          info.emailFilled &&
          info.phoneFilled &&
          info.cardNumberFilled &&
          info.cardExpiryFilled &&
          info.cardCvvFilled &&
          info.passwordFilled &&
          info.firstNameFilled &&
          info.lastNameFilled &&
          info.line1Filled &&
          info.cityFilled &&
          info.postalFilled
        )
      }

      function formatPayPalCheckoutFields(info = {}) {
        const fields = [
          ['邮箱', 'emailFilled'],
          ['电话', 'phoneFilled'],
          ['卡号', 'cardNumberFilled'],
          ['有效期', 'cardExpiryFilled'],
          ['CVV', 'cardCvvFilled'],
          ['密码', 'passwordFilled'],
          ['姓名', 'firstNameFilled'],
          ['姓氏', 'lastNameFilled'],
          ['地址', 'line1Filled'],
          ['城市', 'cityFilled'],
          ['邮编', 'postalFilled']
        ]
        return fields
          .map(([label, key]) => `${label}:${info[key] ? '已填' : '未填'}`)
          .join(' ')
      }

      function formatMissingAssistConfig(missingConfig = []) {
        const labels = {
          phone: '电话',
          cardNumber: '卡号',
          cardExpiry: '有效期',
          cardCvv: 'CVV'
        }
        const missing = (Array.isArray(missingConfig) ? missingConfig : [])
          .map((key) => labels[key] || key)
          .filter(Boolean)
        return missing.length ? `，缺少配置=${missing.join('/')}` : ''
      }

      async function generateHostedLink(tabId) {
        await waitForTabCompleteUntilStopped(tabId).catch(() => {})
        return runScript(tabId, async () => {
          function getErrorDetail(payload) {
            if (!payload || typeof payload !== 'object') {
              return ''
            }
            const direct =
              payload.detail ??
              payload.message ??
              payload.error ??
              payload.error_description ??
              payload.reason
            if (
              direct !== undefined &&
              direct !== null &&
              String(direct).trim()
            ) {
              return String(direct).trim()
            }
            if (
              payload.data &&
              typeof payload.data === 'object' &&
              !Array.isArray(payload.data)
            ) {
              return getErrorDetail(payload.data)
            }
            return ''
          }

          let accessToken = ''
          try {
            const sessionResponse = await fetch('/api/auth/session', {
              credentials: 'include'
            })
            const session = await sessionResponse.json()
            accessToken = String(session?.accessToken || '').trim()
          } catch (error) {
            return {
              ok: false,
              reason: 'session_failed',
              message: `获取 ChatGPT Session Token 失败：${error?.message || error}`
            }
          }

          if (!accessToken) {
            return {
              ok: false,
              reason: 'access_token_empty',
              message: 'ChatGPT accessToken 为空，请确认当前账号已完成登录。'
            }
          }

          const payload = {
            plan_name: 'chatgptplusplan',
            billing_details: {
              country: 'US',
              currency: 'USD'
            },
            cancel_url: 'https://chatgpt.com/#pricing',
            promo_campaign: {
              promo_campaign_id: 'plus-1-month-free',
              is_coupon_from_query_param: false
            },
            checkout_ui_mode: 'hosted'
          }

          let response
          let data = {}
          try {
            response = await fetch(
              'https://chatgpt.com/backend-api/payments/checkout',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
              }
            )
            const responseText = await response.text()
            try {
              data = responseText ? JSON.parse(responseText) : {}
            } catch {
              data = { raw: responseText }
            }
          } catch (error) {
            return {
              ok: false,
              reason: 'request_failed',
              message: `请求 ChatGPT checkout API 失败：${error?.message || error}`
            }
          }

          if (!response.ok) {
            return {
              ok: false,
              reason: 'checkout_api_failed',
              status: response.status,
              message: getErrorDetail(data) || 'ChatGPT checkout API 返回失败。'
            }
          }

          const hostedUrl = String(
            data?.url || data?.stripe_hosted_url || data?.checkout_url || ''
          ).trim()
          if (!hostedUrl) {
            return {
              ok: false,
              reason: 'hosted_url_missing',
              status: response.status,
              message: 'ChatGPT checkout API 未返回 hosted 支付链接。',
              responseKeys:
                data && typeof data === 'object' ? Object.keys(data) : []
            }
          }

          return {
            ok: true,
            hostedUrl,
            checkoutSessionId: String(
              data?.id || data?.checkout_session_id || data?.session_id || ''
            ).trim()
          }
        })
      }

      async function openOrReusePaymentTab(hostedUrl) {
        const registeredTabId =
          await getAliveRegisteredTabId(PLUS_CHECKOUT_SOURCE)
        if (registeredTabId && chrome?.tabs?.update) {
          const tab = await chrome.tabs
            .update(registeredTabId, { url: hostedUrl, active: true })
            .catch(() => null)
          if (tab?.id) {
            return tab.id
          }
        }

        const tab =
          typeof createAutomationTab === 'function'
            ? await createAutomationTab({ url: hostedUrl, active: true })
            : await chrome.tabs.create({ url: hostedUrl, active: true })
        const tabId = Number(tab?.id) || 0
        if (!tabId) {
          throw new Error('步骤 7：打开 Custom Pay 支付页失败。')
        }
        if (typeof registerTab === 'function') {
          await registerTab(PLUS_CHECKOUT_SOURCE, tabId)
        }
        return tabId
      }

      async function executeCustomPayGenerateHostedLink(state = {}) {
        const step = 7
        const tabId = await resolveChatGptTabId(state)
        if (chrome?.tabs?.update) {
          await chrome.tabs.update(tabId, { active: true }).catch(() => {})
        }
        await addLog('步骤 7：正在生成 Custom Pay hosted 支付链接...', 'info', {
          step,
          stepKey: 'custom-pay-generate-hosted-link'
        })
        await addLog(`步骤 7 诊断：ChatGPT tab=${tabId}。`, 'info', {
          step,
          stepKey: 'custom-pay-generate-hosted-link'
        })
        const result = await generateHostedLink(tabId)
        if (!result?.ok) {
          throw new Error(`步骤 7：${formatHostedLinkError(result)}`)
        }
        const hostedUrl = normalizeHostedUrl(result.hostedUrl)
        if (!hostedUrl) {
          throw new Error('步骤 7：ChatGPT checkout API 返回的支付链接无效。')
        }
        await addLog(
          `步骤 7 诊断：hostedUrl=${formatSafeUrlForLog(hostedUrl)}。`,
          'info',
          {
            step,
            stepKey: 'custom-pay-generate-hosted-link'
          }
        )
        const paymentTabId = await openOrReusePaymentTab(hostedUrl)
        await setState({
          customPayChatGptTabId: tabId,
          plusCheckoutTabId: paymentTabId,
          plusCheckoutUrl: hostedUrl,
          plusCheckoutSource: CUSTOM_PAY_METHOD,
          plusManualConfirmationPending: false,
          plusManualConfirmationRequestId: '',
          plusManualConfirmationStep: 0,
          plusManualConfirmationMethod: '',
          plusManualConfirmationTitle: '',
          plusManualConfirmationMessage: ''
        })
        await addLog(
          `步骤 7 诊断：paymentTab=${paymentTabId}，hostedUrl=${formatSafeUrlForLog(hostedUrl)}。`,
          'info',
          {
            step,
            stepKey: 'custom-pay-generate-hosted-link'
          }
        )
        await addLog('步骤 7：Custom Pay 支付链接已生成并打开。', 'ok', {
          step,
          stepKey: 'custom-pay-generate-hosted-link'
        })
        await completeStepFromBackground(step)
      }

      async function preparePayPalAssistPage(tabId, state = {}) {
        await waitForTabCompleteUntilStopped(tabId).catch(() => {})
        await sleepWithStop(1000)
        const currentPayPalAccountId = String(
          state?.currentPayPalAccountId || ''
        ).trim()
        const paypalAccounts = Array.isArray(state?.paypalAccounts)
          ? state.paypalAccounts
          : []
        const selectedPayPalAccount = currentPayPalAccountId
          ? paypalAccounts.find(
              (account) =>
                String(account?.id || '').trim() === currentPayPalAccountId
            ) || null
          : null
        const assistConfig = {
          phone: String(
            state?.customPayAssistPhone || state?.customPayPhone || ''
          ).replace(/\D/g, ''),
          cardNumber: String(state?.customPayCardNumber || '').replace(
            /\D/g,
            ''
          ),
          cardExpiry: String(state?.customPayCardExpiry || '').trim(),
          cardCvv: String(state?.customPayCardCvv || '').replace(/\D/g, ''),
          paypalEmail: String(
            selectedPayPalAccount?.email || state?.paypalEmail || ''
          ).trim()
        }
        const frameResults = await runScriptInAllFrames(
          tabId,
          async (config) => {
            const logs = []
            const wait = (ms) =>
              new Promise((resolve) => setTimeout(resolve, ms))
            const log = (message) => logs.push(String(message || '').trim())

            function isVisible(element) {
              if (!element) return false
              const rect = element.getBoundingClientRect()
              const style = window.getComputedStyle(element)
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                !element.disabled &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
              )
            }

            function setValue(element, value) {
              if (!element) return false
              try {
                element.scrollIntoView({ block: 'center', inline: 'center' })
              } catch (error) {}
              if (element instanceof HTMLElement) {
                try {
                  element.focus({ preventScroll: true })
                } catch (error) {
                  element.focus()
                }
                if (
                  typeof element.click === 'function' &&
                  !(element instanceof HTMLSelectElement)
                ) {
                  element.click()
                }
              }
              const proto =
                element instanceof HTMLTextAreaElement
                  ? HTMLTextAreaElement.prototype
                  : element instanceof HTMLSelectElement
                    ? HTMLSelectElement.prototype
                    : HTMLInputElement.prototype
              const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
              if (descriptor?.set) {
                descriptor.set.call(element, value)
              } else {
                element.value = value
              }
              if (typeof InputEvent === 'function') {
                element.dispatchEvent(
                  new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: String(value || '')
                  })
                )
              } else {
                element.dispatchEvent(new Event('input', { bubbles: true }))
              }
              element.dispatchEvent(new Event('change', { bubbles: true }))
              element.dispatchEvent(new Event('blur', { bubbles: true }))
              return true
            }

            function fill(id, value) {
              const element = document.getElementById(id)
              if (
                !element ||
                value === undefined ||
                value === null ||
                String(value).trim() === ''
              ) {
                return false
              }
              const ok = setValue(element, value)
              if (ok) log(`${id} 已填写`)
              return ok
            }

            function fillSel(selector, value) {
              const element = document.querySelector(selector)
              if (
                !element ||
                value === undefined ||
                value === null ||
                String(value).trim() === ''
              ) {
                return false
              }
              const ok = setValue(element, value)
              if (ok) log(`${selector} 已填写`)
              return ok
            }

            function queryFirstVisible(selectors = []) {
              for (const selector of selectors) {
                let candidates = []
                try {
                  candidates = Array.from(document.querySelectorAll(selector))
                } catch (error) {
                  candidates = []
                }
                const visible = candidates.find((element) => isVisible(element))
                if (visible) return visible
              }
              return null
            }

            function findVisibleField(id, selectors = []) {
              const byId = id ? document.getElementById(id) : null
              if (byId && isVisible(byId)) return byId
              return queryFirstVisible(selectors)
            }

            function fillAny(id, selectors, value) {
              const element = findVisibleField(id, selectors)
              if (
                !element ||
                value === undefined ||
                value === null ||
                String(value).trim() === ''
              ) {
                return false
              }
              const ok = setValue(element, value)
              const filled = String(element.value || '').trim() !== ''
              if (ok && filled) log(`${id} 已填写`)
              return ok && filled
            }

            function findVisibleSelect(id, selectors = []) {
              const byId = id ? document.getElementById(id) : null
              if (byId instanceof HTMLSelectElement && isVisible(byId))
                return byId
              const element = queryFirstVisible(selectors)
              return element instanceof HTMLSelectElement ? element : null
            }

            function getSelectTargetValues(text) {
              const raw = String(text || '')
                .replace(/\s+/g, ' ')
                .trim()
              const values = [raw, raw.toUpperCase(), raw.toLowerCase()]
              if (
                /^(us|usa|united states|united states of america)$/i.test(raw)
              ) {
                values.push(
                  'US',
                  'United States',
                  'United States of America',
                  'USA'
                )
              }
              const usStatePairs = [
                ['Alabama', 'AL'],
                ['Alaska', 'AK'],
                ['Arizona', 'AZ'],
                ['Arkansas', 'AR'],
                ['California', 'CA'],
                ['Colorado', 'CO'],
                ['Connecticut', 'CT'],
                ['Delaware', 'DE'],
                ['District of Columbia', 'DC'],
                ['Florida', 'FL'],
                ['Georgia', 'GA'],
                ['Hawaii', 'HI'],
                ['Idaho', 'ID'],
                ['Illinois', 'IL'],
                ['Indiana', 'IN'],
                ['Iowa', 'IA'],
                ['Kansas', 'KS'],
                ['Kentucky', 'KY'],
                ['Louisiana', 'LA'],
                ['Maine', 'ME'],
                ['Maryland', 'MD'],
                ['Massachusetts', 'MA'],
                ['Michigan', 'MI'],
                ['Minnesota', 'MN'],
                ['Mississippi', 'MS'],
                ['Missouri', 'MO'],
                ['Montana', 'MT'],
                ['Nebraska', 'NE'],
                ['Nevada', 'NV'],
                ['New Hampshire', 'NH'],
                ['New Jersey', 'NJ'],
                ['New Mexico', 'NM'],
                ['New York', 'NY'],
                ['North Carolina', 'NC'],
                ['North Dakota', 'ND'],
                ['Ohio', 'OH'],
                ['Oklahoma', 'OK'],
                ['Oregon', 'OR'],
                ['Pennsylvania', 'PA'],
                ['Rhode Island', 'RI'],
                ['South Carolina', 'SC'],
                ['South Dakota', 'SD'],
                ['Tennessee', 'TN'],
                ['Texas', 'TX'],
                ['Utah', 'UT'],
                ['Vermont', 'VT'],
                ['Virginia', 'VA'],
                ['Washington', 'WA'],
                ['West Virginia', 'WV'],
                ['Wisconsin', 'WI'],
                ['Wyoming', 'WY']
              ]
              const normalizedRaw = raw.replace(/\./g, '').toLowerCase()
              const statePair = usStatePairs.find(
                ([name, code]) =>
                  name.toLowerCase() === normalizedRaw ||
                  code.toLowerCase() === normalizedRaw
              )
              if (statePair) {
                const [name, code] = statePair
                values.push(
                  name,
                  name.toUpperCase(),
                  name.toLowerCase(),
                  code,
                  code.toUpperCase(),
                  code.toLowerCase(),
                  `US-${code}`,
                  `US_${code}`
                )
              }
              return Array.from(new Set(values.filter(Boolean)))
            }

            function findSelectOption(element, text, allowPartial = false) {
              const targets = getSelectTargetValues(text)
              const options = Array.from(element?.options || [])
              const exactValueMatch = options.find((option) =>
                targets.some(
                  (target) =>
                    String(option.value || '')
                      .trim()
                      .toLowerCase() ===
                    String(target || '')
                      .trim()
                      .toLowerCase()
                )
              )
              if (exactValueMatch) return exactValueMatch
              const exactTextMatch = options.find((option) =>
                targets.some(
                  (target) =>
                    String(option.text || '')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .toLowerCase() ===
                    String(target || '')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .toLowerCase()
                )
              )
              if (exactTextMatch) return exactTextMatch
              if (!allowPartial) return null
              return (
                options.find((option) =>
                  targets.some((target) => {
                    const normalizedTarget = String(target || '')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .toLowerCase()
                    if (normalizedTarget.length < 4) return false
                    const optionText = String(option.text || '')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .toLowerCase()
                    const optionValue = String(option.value || '')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .toLowerCase()
                    return (
                      optionText.includes(normalizedTarget) ||
                      optionValue.includes(normalizedTarget)
                    )
                  })
                ) || null
              )
            }

            function getSelectValue(id, selectors = []) {
              const element =
                findVisibleSelect(id, selectors) || document.getElementById(id)
              return String(element?.value || '').trim()
            }

            function hasSelectOption(id, text, selectors = []) {
              return Boolean(
                findSelectOption(
                  findVisibleSelect(id, selectors) ||
                    document.getElementById(id),
                  text,
                  true
                )
              )
            }

            function fillSelect(id, text, selectors = []) {
              const element =
                findVisibleSelect(id, selectors) || document.getElementById(id)
              const target = String(text || '').trim()
              if (!element || !target) return false
              const match = findSelectOption(element, target, true)
              if (!match) return false
              const ok = setValue(element, match.value)
              log(`${id} = ${match.text || match.value}`)
              return (
                ok && String(element.value || '') === String(match.value || '')
              )
            }

            async function waitForSelectOption(
              id,
              text,
              timeoutMs = 5000,
              selectors = []
            ) {
              const startedAt = Date.now()
              while (Date.now() - startedAt < timeoutMs) {
                if (hasSelectOption(id, text, selectors)) return true
                await wait(250)
              }
              return hasSelectOption(id, text, selectors)
            }

            function isSelectSelected(id, text, selectors = []) {
              const element =
                findVisibleSelect(id, selectors) || document.getElementById(id)
              if (!element) return false
              const selected = element.options?.[element.selectedIndex] || null
              const selectedText = String(selected?.text || '')
                .replace(/\s+/g, ' ')
                .trim()
              const selectedValue = String(
                element.value || selected?.value || ''
              )
                .replace(/\s+/g, ' ')
                .trim()
              return getSelectTargetValues(text).some((target) => {
                const normalizedTarget = String(target || '')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .toLowerCase()
                return (
                  normalizedTarget &&
                  (selectedValue.toLowerCase() === normalizedTarget ||
                    selectedText.toLowerCase() === normalizedTarget)
                )
              })
            }

            async function waitForSelectSelected(
              id,
              text,
              timeoutMs = 5000,
              selectors = []
            ) {
              const startedAt = Date.now()
              while (Date.now() - startedAt < timeoutMs) {
                if (isSelectSelected(id, text, selectors)) return true
                await wait(250)
              }
              return isSelectSelected(id, text, selectors)
            }

            async function waitForVisibleField(
              id,
              selectors = [],
              timeoutMs = 5000
            ) {
              const startedAt = Date.now()
              while (Date.now() - startedAt < timeoutMs) {
                const element = findVisibleField(id, selectors)
                if (element) return element
                await wait(250)
              }
              return findVisibleField(id, selectors)
            }

            function normalizeUsPhone(value) {
              const digits = String(value || '').replace(/\D/g, '')
              if (digits.length === 11 && digits.startsWith('1'))
                return digits.slice(1)
              return digits.slice(0, 10)
            }

            function isFilledValue(id, selectors = []) {
              const element =
                findVisibleField(id, selectors) || document.getElementById(id)
              return String(element?.value || '').trim() !== ''
            }

            function getCheckoutFormInfo() {
              return {
                emailFilled: isFilledValue('email', [
                  'input#email',
                  'input[autocomplete="email"]',
                  'input[name="email"]',
                  'input[type="email"]'
                ]),
                phoneFilled: isFilledValue('phone', [
                  'input#phone',
                  'input[data-testid="phone"]',
                  'input[autocomplete="tel"]',
                  'input[type="tel"][name*="phone" i]'
                ]),
                cardNumberFilled: isFilledValue('cardNumber', [
                  'input#cardNumber',
                  'input[autocomplete="cc-number"]',
                  'input[name="cardnumber"]'
                ]),
                cardExpiryFilled: isFilledValue('cardExpiry', [
                  'input#cardExpiry',
                  'input[autocomplete="cc-exp"]',
                  'input[name="exp-date"]'
                ]),
                cardCvvFilled: isFilledValue('cardCvv', [
                  'input#cardCvv',
                  'input[autocomplete="cc-csc"]',
                  'input[name="cvv"]'
                ]),
                passwordFilled: isFilledValue('password', [
                  'input#password',
                  'input[data-testid="lazy-password-input"]',
                  'input[type="password"]',
                  'input[autocomplete="new-password"]',
                  'input[name="password"]'
                ]),
                firstNameFilled: isFilledValue('firstName', [
                  'input#firstName',
                  'input[name="fname"]',
                  'input[autocomplete="given-name"]',
                  'input[name*="first" i]'
                ]),
                lastNameFilled: isFilledValue('lastName', [
                  'input#lastName',
                  'input[name="lname"]',
                  'input[autocomplete="family-name"]',
                  'input[name*="last" i]'
                ]),
                line1Filled: isFilledValue('billingLine1', [
                  'input#billingLine1',
                  'input[name="billingLine1"]',
                  'input[name*="line1" i]',
                  'input[name*="address1" i]',
                  'input[autocomplete="address-line1"]'
                ]),
                cityFilled: isFilledValue('billingCity', [
                  'input#billingCity',
                  'input[name="billingCity"]',
                  'input[name*="city" i]',
                  'input[autocomplete="address-level2"]'
                ]),
                postalFilled: isFilledValue('billingPostalCode', [
                  'input#billingPostalCode',
                  'input[name="billingPostalCode"]',
                  'input[name*="postal" i]',
                  'input[name*="zip" i]',
                  'input[autocomplete="postal-code"]'
                ])
              }
            }

            function isCheckoutFormFilled(info = {}) {
              return Boolean(
                info.emailFilled &&
                info.phoneFilled &&
                info.cardNumberFilled &&
                info.cardExpiryFilled &&
                info.cardCvvFilled &&
                info.passwordFilled &&
                info.firstNameFilled &&
                info.lastNameFilled &&
                info.line1Filled &&
                info.cityFilled &&
                info.postalFilled
              )
            }
            function closeAddressAutocomplete() {
              const active = document.activeElement
              if (active instanceof HTMLElement) {
                active.blur()
              }
              document.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key: 'Escape',
                  code: 'Escape',
                  keyCode: 27,
                  bubbles: true
                })
              )
              Array.from(
                document.querySelectorAll(
                  '.AddressAutocomplete-results, [id$="autocomplete-results"], [role="listbox"]'
                )
              ).forEach((element) => {
                element.style.setProperty('display', 'none', 'important')
                element.style.setProperty('height', '0', 'important')
                element.style.setProperty('overflow', 'hidden', 'important')
              })
            }

            function randEmail() {
              const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
              let name = ''
              for (let index = 0; index < 16; index += 1) {
                name += chars[Math.floor(Math.random() * chars.length)]
              }
              return `${name}@gmail.com`
            }

            function randPass() {
              const letters =
                'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
              const digits = '0123456789'
              const symbols = '!@#$%^'
              const alphabet = letters + digits + symbols
              const seed =
                letters[Math.floor(Math.random() * 26)] +
                letters[26 + Math.floor(Math.random() * 26)] +
                digits[Math.floor(Math.random() * 10)] +
                symbols[Math.floor(Math.random() * symbols.length)]
              let password = seed
              for (let index = 4; index < 14; index += 1) {
                password +=
                  alphabet[Math.floor(Math.random() * alphabet.length)]
              }
              return password
                .split('')
                .sort(() => Math.random() - 0.5)
                .join('')
            }

            function pickFallbackUsAddress() {
              const pool = [
                {
                  street: '350 5th Ave',
                  city: 'New York',
                  state: 'New York',
                  zip: '10118'
                },
                {
                  street: '1 Market St',
                  city: 'San Francisco',
                  state: 'California',
                  zip: '94105'
                },
                {
                  street: '600 Congress Ave',
                  city: 'Austin',
                  state: 'Texas',
                  zip: '78701'
                },
                {
                  street: '100 N Tryon St',
                  city: 'Charlotte',
                  state: 'North Carolina',
                  zip: '28202'
                }
              ]
              return pool[Math.floor(Math.random() * pool.length)]
            }

            function getAddressInfo(address = {}) {
              const summary = [address.city, address.state, address.zip]
                .filter(Boolean)
                .join(', ')
                .replace(/, (\d{5})$/, ' $1')
              return {
                source: address.source || '',
                sourceText: address.sourceText || '',
                summary
              }
            }

            function readCachedUsAddress() {
              try {
                const cached = JSON.parse(
                  sessionStorage.getItem('customPayUsAddress') || '{}'
                )
                if (
                  cached?.street &&
                  cached?.city &&
                  cached?.state &&
                  cached?.zip
                ) {
                  return cached
                }
              } catch (error) {}
              return null
            }

            function cacheUsAddress(address = {}) {
              if (
                address?.street &&
                address?.city &&
                address?.state &&
                address?.zip
              ) {
                try {
                  sessionStorage.setItem(
                    'customPayUsAddress',
                    JSON.stringify(address)
                  )
                } catch (error) {}
              }
              return address
            }

            async function getAddr() {
              const cached = readCachedUsAddress()
              if (cached) {
                return cached
              }
              try {
                const response = await fetch(
                  'https://www.meiguodizhi.com/api/v1/dz',
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      city: 'New York',
                      path: '/',
                      method: 'refresh'
                    })
                  }
                )
                if (!response?.ok) {
                  throw new Error(`HTTP ${response?.status || 0}`)
                }
                const data = await response.json()
                if (data?.status && data.status !== 'ok') {
                  throw new Error(data?.message || data.status)
                }
                const address = data?.address || data || {}
                const street =
                  address.Address ||
                  address.Trans_Address ||
                  address.street ||
                  ''
                const city = address.City || address.city || ''
                const state =
                  address.State_Full || address.State || address.state || ''
                const zip = String(address.Zip_Code || address.zip || '')
                  .replace(/\D/g, '')
                  .slice(0, 5)
                if (!street || !city || !state || !zip) {
                  throw new Error('地址接口返回字段不完整')
                }
                log(`已获取美国地址：${city}, ${state} ${zip}`)
                return cacheUsAddress({
                  street,
                  city,
                  state,
                  zip,
                  source: 'meiguodizhi',
                  sourceText: 'meiguodizhi 接口'
                })
              } catch (error) {
                const fallback = pickFallbackUsAddress()
                log(
                  `美国地址接口失败，使用内置美国地址：${fallback.city}, ${fallback.state} ${fallback.zip}（${error?.message || error}）`
                )
                return cacheUsAddress({
                  ...fallback,
                  source: 'builtin_us_fallback',
                  sourceText: '内置美国地址池'
                })
              }
            }

            function isButtonDisabled(element) {
              if (!element) return true
              const ariaDisabled =
                String(
                  element.getAttribute?.('aria-disabled') || ''
                ).toLowerCase() === 'true'
              const dataDisabled =
                String(
                  element.getAttribute?.('data-disabled') || ''
                ).toLowerCase() === 'true'
              return Boolean(
                element.disabled ||
                ariaDisabled ||
                dataDisabled ||
                element.classList?.contains('disabled')
              )
            }

            function isButtonBusy(element) {
              if (!element) return false
              const ariaBusy =
                String(
                  element.getAttribute?.('aria-busy') || ''
                ).toLowerCase() === 'true'
              return Boolean(
                ariaBusy ||
                element.classList?.contains('SubmitButton--processing')
              )
            }

            function getButtonText(element) {
              return String(
                element?.textContent ||
                  element?.value ||
                  element?.getAttribute?.('aria-label') ||
                  ''
              )
                .replace(/\s+/g, ' ')
                .trim()
            }

            function dispatchClickSequence(element) {
              if (!element) return false
              try {
                element.scrollIntoView({ block: 'center', inline: 'center' })
              } catch (error) {}
              try {
                element.focus({ preventScroll: true })
              } catch (error) {
                try {
                  element.focus()
                } catch (focusError) {}
              }
              const eventOptions = {
                bubbles: true,
                cancelable: true,
                view: window
              }
              for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
                try {
                  element.dispatchEvent(new MouseEvent(type, eventOptions))
                } catch (error) {
                  element.dispatchEvent(new Event(type, eventOptions))
                }
              }
              if (typeof element.click === 'function') {
                element.click()
              } else {
                element.dispatchEvent(new MouseEvent('click', eventOptions))
              }
              return true
            }

            function findPayPalOnboardingContinueButton(rootElement) {
              const selectors = [
                'button[type="submit"].actionContinue',
                'button.scTrack\\:next',
                'button[type="submit"]'
              ]
              const candidates = selectors.flatMap((selector) =>
                Array.from(rootElement?.querySelectorAll(selector) || [])
              )
              return (
                candidates.find((candidate) => {
                  const text = getButtonText(candidate)
                  return (
                    isVisible(candidate) &&
                    !isButtonDisabled(candidate) &&
                    !isButtonBusy(candidate) &&
                    /繼續付款|继续付款|continue/i.test(text)
                  )
                }) ||
                candidates.find(
                  (candidate) =>
                    isVisible(candidate) &&
                    !isButtonDisabled(candidate) &&
                    !isButtonBusy(candidate)
                ) ||
                null
              )
            }

            function findPayPalCreateAccountButton(rootElement = document) {
              const createAccountPattern =
                /创建(一个)?帐户|创建(一个)?账户|建立(帳戶|賬戶|户|账户)|create\s+(an?\s+)?account|sign\s*up/i
              const selectors = [
                'form[data-testid="xo-onboarding-form"] button[type="submit"]',
                '[data-testid="xo-onboarding-form"] button',
                '#startOnboardingFlow',
                'button#startOnboardingFlow',
                'button.scTrack\\:unifiedlogin-click-signup-button',
                'button.onboardingFlowContentKey',
                '#guestCheckout',
                'a#guestCheckout[aria-label="sign up"]',
                '#startOnboardingFlowExtWallet',
                'button, a, [role="button"], input[type="button"], input[type="submit"]'
              ]
              const candidates = selectors.flatMap((selector) =>
                Array.from(rootElement?.querySelectorAll(selector) || [])
              )
              return (
                candidates.find((candidate) => {
                  const text = getButtonText(candidate)
                  return (
                    isVisible(candidate) &&
                    !isButtonDisabled(candidate) &&
                    !isButtonBusy(candidate) &&
                    (candidate.id === 'startOnboardingFlow' ||
                      candidate.id === 'guestCheckout' ||
                      candidate.id === 'startOnboardingFlowExtWallet' ||
                      candidate.closest?.('form[data-testid="xo-onboarding-form"]') ||
                      createAccountPattern.test(text))
                  )
                }) || null
              )
            }

            async function handlePayPalCreateAccountPage() {
              const createAccountButton = findPayPalCreateAccountButton(document)
              if (!createAccountButton) {
                return null
              }
              const text = getButtonText(createAccountButton)
              dispatchClickSequence(createAccountButton)
              await wait(500)
              log(
                `已点击 PayPal 创建账户按钮：${text || createAccountButton.id || '按钮'}`
              )
              return {
                kind: 'paypal-login',
                clickedAssistButton: true,
                clickResult: {
                  clicked: true,
                  buttonText: text,
                  buttonId: createAccountButton.id || '',
                  reason: 'paypal_create_account'
                },
                status: getPaymentPageStatus(),
                logs,
                url: location.href
              }
            }

            function getPayPalHref(element) {
              const href = String(
                element?.getAttribute?.('href') || element?.href || ''
              ).trim()
              if (!href) return ''
              try {
                const url = new URL(href, location.href)
                return `${url.pathname}${url.search}`
              } catch (error) {
                return href
              }
            }

            function findPayPalProfileLink() {
              const candidates = Array.from(
                document.querySelectorAll('a, [role="link"], [href]')
              )
              return (
                candidates.find((candidate) => {
                  const href = getPayPalHref(candidate)
                  const text = getButtonText(candidate)
                  return (
                    isVisible(candidate) &&
                    (/\/pay\/profile(?:\?|$|\/)/i.test(href) ||
                      (/profile|account|账户|帳戶|头像|頭像|个人资料|個人資料/i.test(
                        text
                      ) && /paypal/i.test(`${href} ${location.href}`)))
                  )
                }) || null
              )
            }

            function isPayPalProfilePage() {
              return Boolean(
                /\/pay\/profile(?:\?|$|\/)/i.test(
                  `${location.pathname}${location.search}`
                ) ||
                  document.querySelector(
                    '[data-atomic-wait-viewname="profile"]'
                  )
              )
            }

            function findPayPalLogoutButton() {
              const candidates = Array.from(
                document.querySelectorAll(
                  'button, a, [role="button"], input[type="button"], input[type="submit"]'
                )
              )
              return (
                candidates.find((candidate) => {
                  const text = getButtonText(candidate)
                  return (
                    isVisible(candidate) &&
                    !isButtonDisabled(candidate) &&
                    !isButtonBusy(candidate) &&
                    (candidate.getAttribute?.('data-atomic-wait-intent') ===
                      'Logout' ||
                      candidate.getAttribute?.('data-atomic-wait-task') ===
                        'select_logout' ||
                      (candidate.getAttribute?.('data-atomic-wait-viewname') ===
                        'profile' &&
                        /logout|log\s*out|退出登录|登出|注销|註銷/i.test(
                          text
                        )) ||
                      /^(logout|log\s*out|退出登录|登出|注销|註銷)$/i.test(
                        text
                      ))
                  )
                }) || null
              )
            }

            async function handlePayPalAccountPage() {
              const logoutButton = findPayPalLogoutButton()
              if (logoutButton) {
                const text = getButtonText(logoutButton)
                dispatchClickSequence(logoutButton)
                await wait(500)
                log(`已点击 PayPal 退出登录按钮：${text || 'Logout'}`)
                return {
                  kind: 'paypal-logout',
                  clickedAssistButton: true,
                  clickResult: {
                    clicked: true,
                    buttonText: text
                  },
                  status: getPaymentPageStatus(),
                  logs,
                  url: location.href
                }
              }

              if (isPayPalProfilePage()) {
                log('PayPal profile 页面未找到可点击的退出登录按钮。')
                return {
                  kind: 'paypal-logout',
                  clickedAssistButton: false,
                  clickResult: {
                    clicked: false,
                    reason: 'paypal_logout_button_not_found'
                  },
                  status: getPaymentPageStatus(),
                  logs,
                  url: location.href
                }
              }

              const profileLink = findPayPalProfileLink()
              if (!profileLink) {
                return null
              }
              const text = getButtonText(profileLink)
              const href = getPayPalHref(profileLink)
              dispatchClickSequence(profileLink)
              await wait(500)
              log(`已点击 PayPal profile 入口：${text || href || 'profile'}`)
              return {
                kind: 'paypal-profile',
                clickedAssistButton: true,
                clickResult: {
                  clicked: true,
                  buttonText: text,
                  href
                },
                status: getPaymentPageStatus(),
                logs,
                url: location.href
              }
            }

            function findActionButton() {
              const selectors = [
                'button[data-testid="hosted-payment-submit-button"]',
                'button[data-testid="submit-button"]',
                'button[data-atomic-wait-intent="Submit_Email"]',
                'button.SubmitButton--complete',
                'button[type="submit"]'
              ]
              const candidates = selectors.flatMap((selector) =>
                Array.from(document.querySelectorAll(selector))
              )
              const buttons = candidates.length
                ? candidates
                : Array.from(
                    document.querySelectorAll(
                      'button, [role="button"], input[type="button"], input[type="submit"]'
                    )
                  )
              return (
                buttons.find((candidate) => {
                  const text = getButtonText(candidate)
                  return (
                    isVisible(candidate) &&
                    !isButtonDisabled(candidate) &&
                    !isButtonBusy(candidate) &&
                    /subscribe|订阅|next|下一页|continue|继续|agree|同意/i.test(
                      text
                    )
                  )
                }) ||
                buttons.find(
                  (candidate) =>
                    isVisible(candidate) &&
                    !isButtonDisabled(candidate) &&
                    !isButtonBusy(candidate)
                ) ||
                null
              )
            }

            async function waitForActionButtonReady(timeoutMs = 5000) {
              const startedAt = Date.now()
              while (Date.now() - startedAt < timeoutMs) {
                if (findActionButton()) return true
                await wait(250)
              }
              return Boolean(findActionButton())
            }

            async function clickBtn(retries = 0) {
              const button = findActionButton()
              if (!button) {
                if (retries < 10) {
                  await wait(1000)
                  return clickBtn(retries + 1)
                }
                return { clicked: false, reason: 'button_not_found' }
              }
              const text = getButtonText(button)
              if (
                /(^|\b)(pay|payment|complete order|place order)(\b|$)|付款|支付/i.test(
                  text
                )
              ) {
                log(`跳过最终支付按钮：${text}`)
                return {
                  clicked: false,
                  skippedFinalPayment: true,
                  buttonText: text
                }
              }
              if (
                isButtonDisabled(button) ||
                !isVisible(button) ||
                isButtonBusy(button)
              ) {
                if (retries < 10) {
                  await wait(1000)
                  return clickBtn(retries + 1)
                }
                return {
                  clicked: false,
                  reason: isButtonDisabled(button)
                    ? 'button_disabled'
                    : isButtonBusy(button)
                      ? 'button_processing'
                      : 'button_not_visible',
                  buttonText: text
                }
              }
              dispatchClickSequence(button)
              await wait(500)
              const afterText = getButtonText(button)
              log(`已点击：${text || '继续按钮'}`)
              return {
                clicked: true,
                buttonText: text,
                afterButtonText: afterText
              }
            }

            async function clickPayPalButton(
              matchText,
              selectors = [],
              retries = 0
            ) {
              let button = selectors
                .flatMap((selector) =>
                  Array.from(document.querySelectorAll(selector))
                )
                .find(
                  (candidate) => isVisible(candidate) && !candidate.disabled
                )
              if (!button) {
                button = Array.from(
                  document.querySelectorAll(
                    'button, a, [role="button"], input[type="button"], input[type="submit"]'
                  )
                ).find((candidate) => {
                  const text = String(
                    candidate.textContent ||
                      candidate.value ||
                      candidate.getAttribute('aria-label') ||
                      ''
                  )
                    .replace(/\s+/g, ' ')
                    .trim()
                  return isVisible(candidate) && matchText.test(text)
                })
              }
              if (!button) {
                if (retries < 10) {
                  await wait(1000)
                  return clickPayPalButton(matchText, selectors, retries + 1)
                }
                return { clicked: false, reason: 'button_not_found' }
              }
              const text = String(
                button.textContent ||
                  button.value ||
                  button.getAttribute('aria-label') ||
                  ''
              )
                .replace(/\s+/g, ' ')
                .trim()
              if (button.disabled || !isVisible(button)) {
                if (retries < 10) {
                  await wait(1000)
                  return clickPayPalButton(matchText, selectors, retries + 1)
                }
                return {
                  clicked: false,
                  reason: button.disabled
                    ? 'button_disabled'
                    : 'button_not_visible',
                  buttonText: text
                }
              }
              button.scrollIntoView({ block: 'center', inline: 'center' })
              button.click()
              log(`已点击 PayPal 按钮：${text || '按钮'}`)
              return { clicked: true, buttonText: text }
            }

            function getControlText(element) {
              return String(
                element?.textContent ||
                  element?.value ||
                  element?.getAttribute?.('aria-label') ||
                  ''
              )
                .replace(/\s+/g, ' ')
                .trim()
            }

            function isPayPalCheckoutSignupPage() {
              const host = String(location.host || '').toLowerCase()
              const path = String(location.pathname || '').toLowerCase()
              if (!host.includes('paypal.com') || !path.includes('/checkoutweb/')) {
                return false
              }
              return Boolean(
                document.querySelector(
                  'select#country, select[name="country"], input#password, input[data-testid="lazy-password-input"], button[data-testid="submit-button"], button[data-atomic-wait-intent="click_select_create_account_and_continue"]'
                )
              )
            }

            function isStripeHostedPaymentPageLocation() {
              const hostname = String(location.hostname || '').toLowerCase()
              const path = String(location.pathname || '')
              return (
                /^\/(?:c\/)?pay\/cs_(?:live|test)_/i.test(path) &&
                (hostname === 'pay.openai.com' || hostname === 'checkout.stripe.com')
              )
            }

            function shouldIgnoreTerminalPaymentStatus() {
              return isStripeHostedPaymentPageLocation() || isPayPalCheckoutSignupPage()
            }

            function findScaInputs() {
              const host = String(location.host || '').toLowerCase()
              if (!host.includes('paypal.com') || isStripeHostedPaymentPageLocation()) {
                return []
              }
              return Array.from(
                document.querySelectorAll(
                  '[data-testid="sca-confirm-multi-field"] input[name^="ciBasic-"], #ciBasic input[name^="ciBasic-"]'
                )
              )
                .filter((input) => isVisible(input))
                .sort((left, right) =>
                  String(left.name || left.id || '').localeCompare(
                    String(right.name || right.id || '')
                  )
                )
            }

            function hasRealScaMultiField(inputs = []) {
              return inputs.length >= 6
            }

            function findOtpInputs(bodyText = '') {
              if (shouldIgnoreTerminalPaymentStatus()) {
                return []
              }
              return Array.from(document.querySelectorAll('input, textarea')).filter(
                (input) => {
                  const type = String(input?.type || '').toLowerCase()
                  const label = `${input.name || ''} ${input.id || ''} ${input.placeholder || ''} ${input.autocomplete || ''} ${input.getAttribute?.('aria-label') || ''}`
                  const context = `${label} ${bodyText} ${location.href}`
                  return (
                    isVisible(input) &&
                    !input.readOnly &&
                    ['text', 'tel', 'number', 'password', ''].includes(type) &&
                    /(otp|code|token|verification|security|one[ -]?time|验证码|驗證|验证|代碼|代码)/i.test(
                      context
                    )
                  )
                }
              )
            }

            function findConsentButton() {
              if (isStripeHostedPaymentPageLocation()) {
                return null
              }
              const isCheckoutSignup = isPayPalCheckoutSignupPage()
              return (
                Array.from(
                  document.querySelectorAll(
                    '#consentButton, button[data-testid="consentButton"], button, [role="button"], input[type="button"], input[type="submit"]'
                  )
                ).find((candidate) => {
                  const text = getControlText(candidate)
                  const isExplicitConsent =
                    candidate.id === 'consentButton' ||
                    candidate.getAttribute?.('data-testid') ===
                      'consentButton'
                  return (
                    isVisible(candidate) &&
                    !candidate.disabled &&
                    (isExplicitConsent ||
                      (!isCheckoutSignup &&
                        /同意并继续|同意並繼續|agree\s*(?:and|&)?\s*continue/i.test(text)))
                  )
                }) || null
              )
            }

            function getPaymentPageStatus() {
              const bodyText = String(document.body?.innerText || '')
                .replace(/\s+/g, ' ')
                .trim()
              const scaInputs = findScaInputs()
              const otpInputs = findOtpInputs(bodyText)
              const consentButton = findConsentButton()
              const completeByText =
                /支付成功|付款成功|订阅成功|完成支付|已完成订阅|thank\s+you|payment\s+(?:succeeded|successful|completed)|paid\s+successfully/i.test(
                  bodyText
                )
              return {
                url: location.href,
                host: location.host,
                path: location.pathname,
                readyState: document.readyState,
                hasScaMultiField: hasRealScaMultiField(scaInputs),
                scaInputCount: scaInputs.length,
                hasOtpInput: otpInputs.length > 0,
                otpInputCount: otpInputs.length,
                hasConsentButton: Boolean(consentButton),
                consentButtonText: getControlText(consentButton),
                looksComplete: completeByText,
                bodyTextPreview: bodyText.slice(0, 240)
              }
            }

            function clickConsentButton() {
              const button = findConsentButton()
              if (!button) {
                return { clicked: false, reason: 'consent_not_found' }
              }
              const text = getControlText(button)
              button.scrollIntoView({ block: 'center', inline: 'center' })
              button.click()
              log(`已点击 PayPal 同意按钮：${text || '同意并继续'}`)
              return { clicked: true, buttonText: text }
            }

            async function handleCurrentPaymentStatus(currentStatus) {
              if (currentStatus.hasScaMultiField) {
                return {
                  kind: 'paypal-sca',
                  clickedAssistButton: false,
                  clickResult: { clicked: false, reason: 'sca_required' },
                  status: currentStatus,
                  logs,
                  url: location.href
                }
              }
              if (currentStatus.hasConsentButton) {
                return {
                  kind: 'paypal-consent',
                  clickedAssistButton: false,
                  clickResult: {
                    clicked: false,
                    reason: 'consent_pending_for_otp_confirm'
                  },
                  status: currentStatus,
                  logs,
                  url: location.href
                }
              }
              if (currentStatus.looksComplete) {
                return {
                  kind: 'complete',
                  clickedAssistButton: false,
                  clickResult: { clicked: false, reason: 'already_complete' },
                  status: currentStatus,
                  logs,
                  url: location.href
                }
              }
              return null
            }

            function getMissingCheckoutConfig() {
              return Object.entries({
                phone: normalizeUsPhone(config.phone),
                cardNumber: config.cardNumber,
                cardExpiry: config.cardExpiry,
                cardCvv: config.cardCvv
              })
                .filter(([, value]) => !String(value || '').trim())
                .map(([key]) => key)
            }

            async function handleStripeCheckoutPage() {
              const paypalButton =
                document.querySelector(
                  '[data-testid="paypal-accordion-item-button"]'
                ) || document.querySelector('.paypal-accordion-item button')
              if (paypalButton) {
                paypalButton.click()
                await wait(500)
                paypalButton.click()
                log('已选择 PayPal')
              }
              await wait(3000)
              const addr = await getAddr()
              const countrySelected = fillSelect('billingCountry', 'US')
              await wait(500)
              const countryValue = getSelectValue('billingCountry')
              const hasStateOption =
                countrySelected && countryValue === 'US'
                  ? await waitForSelectOption(
                      'billingAdministrativeArea',
                      addr.state
                    )
                  : false
              fillSel('#billingAddressLine1', addr.street)
              closeAddressAutocomplete()
              fillSel('#billingLocality', addr.city)
              fillSel('#billingPostalCode', addr.zip)
              const stateSelected = hasStateOption
                ? fillSelect('billingAdministrativeArea', addr.state)
                : false
              closeAddressAutocomplete()
              if (countryValue !== 'US' || !stateSelected) {
                const reason =
                  countryValue !== 'US'
                    ? 'country_not_us'
                    : 'state_not_selected'
                log(
                  `Stripe Billing 未完成：country=${countryValue || '空'} stateSelected=${stateSelected ? 'yes' : 'no'}`
                )
                return {
                  kind: 'stripe',
                  countrySelected,
                  stateSelected,
                  countryValue,
                  clickedAssistButton: false,
                  clickResult: { clicked: false, reason },
                  addressInfo: getAddressInfo(addr),
                  status: getPaymentPageStatus(),
                  logs,
                  url: location.href
                }
              }
              const checkbox = document.getElementById(
                'termsOfServiceConsentCheckbox'
              )
              if (checkbox && !checkbox.checked) {
                checkbox.click()
                log('已勾选服务条款')
              }
              await waitForActionButtonReady(5000)
              const clickResult = await clickBtn()
              return {
                kind: 'stripe',
                countrySelected,
                stateSelected,
                countryValue: getSelectValue('billingCountry'),
                clickedAssistButton: Boolean(clickResult.clicked),
                clickResult,
                addressInfo: getAddressInfo(addr),
                status: getPaymentPageStatus(),
                logs,
                url: location.href
              }
            }

            async function handlePayPalOnboardingPage() {
              const onboardingRoot = document.querySelector('#onboardingFlow')
              const onboardingForm =
                onboardingRoot?.querySelector(
                  'form[name="beginOnboardingFlow"], form[action*="/signin/onboarding/continue"]'
                ) || null
              const onboardingEmail =
                onboardingRoot?.querySelector(
                  '#onboardingFlowEmail, input[name="login_email"][type="email"]'
                ) || null
              if (!onboardingRoot || !onboardingForm || !onboardingEmail) {
                return null
              }
              const email = String(config.paypalEmail || '').trim()
              if (!email) {
                log('PayPal onboarding 页面缺少可填写的 PayPal 邮箱配置。')
                return {
                  kind: 'paypal-onboarding',
                  clickedAssistButton: false,
                  clickResult: {
                    clicked: false,
                    reason: 'paypal_email_missing'
                  },
                  status: getPaymentPageStatus(),
                  logs,
                  url: location.href
                }
              }
              const emailFilled = setValue(onboardingEmail, email)
              const continueButton = findPayPalOnboardingContinueButton(
                onboardingForm || onboardingRoot
              )
              if (!continueButton) {
                log('PayPal onboarding 页面未找到继续付款按钮。')
                return {
                  kind: 'paypal-onboarding',
                  emailFilled,
                  clickedAssistButton: false,
                  clickResult: {
                    clicked: false,
                    reason: 'paypal_onboarding_continue_not_found'
                  },
                  status: getPaymentPageStatus(),
                  logs,
                  url: location.href
                }
              }
              const text = getButtonText(continueButton)
              dispatchClickSequence(continueButton)
              await wait(500)
              log(`已填写 PayPal onboarding 邮箱并点击继续付款：${email}`)
              return {
                kind: 'paypal-onboarding',
                emailFilled,
                clickedAssistButton: true,
                clickResult: {
                  clicked: true,
                  buttonText: text,
                  buttonId: continueButton.id || ''
                },
                status: getPaymentPageStatus(),
                logs,
                url: location.href
              }
            }

            async function handlePayPalUnifiedLoginPage() {
              const contentRoot = document.querySelector('#content')
              const checkoutLoginForm =
                Array.from(
                  contentRoot?.querySelectorAll(
                    'form[name="login"], form.proceed[name="login"], form[action*="/signin"]'
                  ) || []
                ).find((form) => {
                  const action = String(
                    form.getAttribute?.('action') || form.action || ''
                  )
                  return (
                    /\/signin(?:\?|$)/i.test(action) &&
                    /intent=checkout/i.test(action) &&
                    String(
                      form.getAttribute?.('name') || form.name || ''
                    ).toLowerCase() === 'login'
                  )
                }) || null
              if (!checkoutLoginForm) {
                return null
              }
              const signupContainer =
                contentRoot?.querySelector('#signupContainer') || null
              const createAccountPattern =
                /创建(一个)?帐户|创建(一个)?账户|建立(帳戶|賬戶|户|账户)|create\s+(an?\s+)?account|sign\s*up/i
              const createAccountSelectors = [
                '#startOnboardingFlow',
                'button#startOnboardingFlow',
                'button.scTrack\\:unifiedlogin-click-signup-button',
                'button.onboardingFlowContentKey'
              ]
              const fallbackCreateAccountSelectors = [
                '#guestCheckout',
                'a#guestCheckout[aria-label="sign up"]',
                '#startOnboardingFlowExtWallet'
              ]
              const findCreateAccountButton = (rootElement, selectors) =>
                selectors
                  .flatMap((selector) =>
                    Array.from(rootElement?.querySelectorAll(selector) || [])
                  )
                  .find((candidate) => {
                    const text = String(
                      candidate.textContent ||
                        candidate.value ||
                        candidate.getAttribute?.('aria-label') ||
                        ''
                    )
                      .replace(/\s+/g, ' ')
                      .trim()
                    return (
                      isVisible(candidate) &&
                      !candidate.disabled &&
                      (candidate.id === 'startOnboardingFlow' ||
                        candidate.id === 'guestCheckout' ||
                        candidate.id === 'startOnboardingFlowExtWallet' ||
                        createAccountPattern.test(text))
                    )
                  }) || null
              const createAccountButton =
                findCreateAccountButton(
                  signupContainer,
                  createAccountSelectors
                ) ||
                findCreateAccountButton(
                  contentRoot,
                  fallbackCreateAccountSelectors
                )
              if (!createAccountButton) {
                log(
                  `PayPal checkout 登录页未找到创建账户按钮：signupContainer=${signupContainer ? 'yes' : 'no'}`
                )
                return {
                  kind: 'paypal-login',
                  clickedAssistButton: false,
                  clickResult: {
                    clicked: false,
                    reason: 'paypal_login_create_account_not_found',
                    checkoutLoginForm: true,
                    signupContainerFound: Boolean(signupContainer)
                  },
                  status: getPaymentPageStatus(),
                  logs,
                  url: location.href
                }
              }
              const text = String(
                createAccountButton.textContent ||
                  createAccountButton.value ||
                  createAccountButton.getAttribute?.('aria-label') ||
                  ''
              )
                .replace(/\s+/g, ' ')
                .trim()
              dispatchClickSequence(createAccountButton)
              await wait(500)
              log(
                `已点击 PayPal 创建账户按钮：${text || createAccountButton.id || '按钮'}`
              )
              return {
                kind: 'paypal-login',
                clickedAssistButton: true,
                clickResult: {
                  clicked: true,
                  buttonText: text,
                  buttonId: createAccountButton.id || ''
                },
                status: getPaymentPageStatus(),
                logs,
                url: location.href
              }
            }

            async function handlePayPalCheckoutSignupPage() {
              const addr = await getAddr()
              const countrySelectors = [
                'select#country',
                'select[data-testid="countrySelector"]',
                'select[name="country"]'
              ]
              const stateSelectors = [
                'select#billingState',
                'select[name="billingState"]'
              ]
              const country = findVisibleSelect('country', countrySelectors)
              const countrySelected = country
                ? fillSelect('country', 'US', countrySelectors)
                : false
              if (countrySelected) {
                await waitForSelectSelected(
                  'country',
                  'US',
                  5000,
                  countrySelectors
                )
                await waitForVisibleField(
                  'phone',
                  [
                    'input#phone',
                    'input[data-testid="phone"]',
                    'input[autocomplete="tel"]',
                    'input[type="tel"][name*="phone" i]'
                  ],
                  8000
                )
              }
              const countryValue = getSelectValue('country', countrySelectors)
              const countryIsUs =
                isSelectSelected('country', 'US', countrySelectors) ||
                countryValue === 'US'
              const hasStateOption = countryIsUs
                ? await waitForSelectOption(
                    'billingState',
                    addr.state,
                    10000,
                    stateSelectors
                  )
                : false
              const emailFilled = fillAny(
                'email',
                [
                  'input#email',
                  'input[autocomplete="email"]',
                  'input[name="email"]',
                  'input[type="email"]'
                ],
                randEmail()
              )
              fillSelect('phoneType', 'Mobile', [
                'select#phoneType',
                'select[name="phoneType"]'
              ])
              fillSelect('dialingCode', 'US', [
                'select#dialingCode',
                'select[name="dialingCode"]'
              ])
              const phoneFilled = fillAny(
                'phone',
                [
                  'input#phone',
                  'input[data-testid="phone"]',
                  'input[autocomplete="tel"]',
                  'input[type="tel"][name*="phone" i]'
                ],
                normalizeUsPhone(config.phone)
              )
              const cardNumberFilled = fillAny(
                'cardNumber',
                [
                  'input#cardNumber',
                  'input[autocomplete="cc-number"]',
                  'input[name="cardnumber"]'
                ],
                config.cardNumber
              )
              const cardExpiryFilled = fillAny(
                'cardExpiry',
                [
                  'input#cardExpiry',
                  'input[autocomplete="cc-exp"]',
                  'input[name="exp-date"]'
                ],
                config.cardExpiry
              )
              const cardCvvFilled = fillAny(
                'cardCvv',
                [
                  'input#cardCvv',
                  'input[autocomplete="cc-csc"]',
                  'input[name="cvv"]'
                ],
                config.cardCvv
              )
              const firstNameFilled = fillAny(
                'firstName',
                [
                  'input#firstName',
                  'input[name="fname"]',
                  'input[autocomplete="given-name"]',
                  'input[name*="first" i]'
                ],
                'James'
              )
              const lastNameFilled = fillAny(
                'lastName',
                [
                  'input#lastName',
                  'input[name="lname"]',
                  'input[autocomplete="family-name"]',
                  'input[name*="last" i]'
                ],
                'Smith'
              )
              const line1Filled = fillAny(
                'billingLine1',
                [
                  'input#billingLine1',
                  'input[name="billingLine1"]',
                  'input[name*="line1" i]',
                  'input[name*="address1" i]',
                  'input[autocomplete="address-line1"]'
                ],
                addr.street
              )
              closeAddressAutocomplete()
              const cityFilled = fillAny(
                'billingCity',
                [
                  'input#billingCity',
                  'input[name="billingCity"]',
                  'input[name*="city" i]',
                  'input[autocomplete="address-level2"]'
                ],
                addr.city
              )
              let stateSelected = false
              if (hasStateOption) {
                stateSelected = fillSelect(
                  'billingState',
                  addr.state,
                  stateSelectors
                )
                if (stateSelected) {
                  stateSelected = await waitForSelectSelected(
                    'billingState',
                    addr.state,
                    3000,
                    stateSelectors
                  )
                }
              }
              const postalFilled = fillAny(
                'billingPostalCode',
                [
                  'input#billingPostalCode',
                  'input[name="billingPostalCode"]',
                  'input[name*="postal" i]',
                  'input[name*="zip" i]',
                  'input[autocomplete="postal-code"]'
                ],
                addr.zip
              )
              const passwordFilled = fillAny(
                'password',
                [
                  'input#password',
                  'input[data-testid="lazy-password-input"]',
                  'input[type="password"]',
                  'input[autocomplete="new-password"]',
                  'input[name="password"]'
                ],
                randPass()
              )
              closeAddressAutocomplete()
              await wait(500)
              const checkoutFormInfo = getCheckoutFormInfo()
              const attempted = {
                emailFilled,
                phoneFilled,
                cardNumberFilled,
                cardExpiryFilled,
                cardCvvFilled,
                passwordFilled,
                firstNameFilled,
                lastNameFilled,
                line1Filled,
                cityFilled,
                postalFilled
              }
              if (
                !countryIsUs ||
                !stateSelected ||
                !isCheckoutFormFilled(checkoutFormInfo)
              ) {
                const reason = !countryIsUs
                  ? 'country_not_us'
                  : !stateSelected
                    ? 'state_not_selected'
                    : 'form_not_filled'
                log(
                  `PayPal Checkout 表单未完成：country=${countryValue || '空'} countryIsUs=${countryIsUs ? 'yes' : 'no'} stateSelected=${stateSelected ? 'yes' : 'no'} fields=${JSON.stringify(checkoutFormInfo)}`
                )
                return {
                  kind: 'paypal-checkout',
                  countrySelected,
                  stateSelected,
                  countryValue,
                  checkoutFormInfo: { ...checkoutFormInfo, attempted },
                  missingConfig: getMissingCheckoutConfig(),
                  clickedAssistButton: false,
                  clickResult: { clicked: false, reason },
                  addressInfo: getAddressInfo(addr),
                  status: getPaymentPageStatus(),
                  logs,
                  url: location.href
                }
              }
              const createAccountConsent = await clickPayPalButton(
                /同意並繼續|同意并继续|同意并创建(帐户|账户)|agree\s*(?:and)?\s*continue|agree\s+and\s+create/i,
                [
                  'button[data-testid="submit-button"]',
                  'button[data-atomic-wait-intent="click_select_create_account_and_continue"]',
                  'button[data-testid="createAccountButton"]',
                  'button[data-testid="submitButton"]',
                  'button[type="submit"]'
                ]
              )
              const clickResult = createAccountConsent.clicked
                ? createAccountConsent
                : await clickBtn()
              return {
                kind: 'paypal-checkout',
                countrySelected,
                stateSelected,
                countryValue: getSelectValue('country', countrySelectors),
                checkoutFormInfo,
                missingConfig: getMissingCheckoutConfig(),
                clickedAssistButton: Boolean(clickResult.clicked),
                clickResult,
                addressInfo: getAddressInfo(addr),
                status: getPaymentPageStatus(),
                logs,
                url: location.href
              }
            }

            async function handleGenericPaymentPage(
              currentStatus,
              isStripeHostedPaymentPage
            ) {
              const hasKnownPaymentSurface =
                host.includes('paypal.com') ||
                isStripeHostedPaymentPage ||
                Boolean(
                  document.querySelector(
                    'select#billingCountry, select#country, input#cardNumber, input#cardExpiry, input#cardCvv, [data-testid="sca-confirm-multi-field"], #consentButton'
                  )
                )
              if (!hasKnownPaymentSurface) {
                return {
                  kind: 'frame-scan',
                  clickedAssistButton: false,
                  clickResult: { clicked: false, reason: 'non_payment_frame' },
                  status: currentStatus,
                  logs,
                  url: location.href
                }
              }

              const countrySelect = document.querySelector(
                'select#billingCountry, select[name*="country" i], select[autocomplete="billing country"]'
              )
              let countrySelected = false
              if (countrySelect) {
                countrySelect.value = 'US'
                countrySelect.dispatchEvent(
                  new Event('input', { bubbles: true })
                )
                countrySelect.dispatchEvent(
                  new Event('change', { bubbles: true })
                )
                countrySelected = countrySelect.value === 'US'
              }
              const clickResult = await clickBtn()
              return {
                kind: 'generic',
                countrySelected,
                clickedAssistButton: Boolean(clickResult.clicked),
                clickResult,
                status: getPaymentPageStatus(),
                logs,
                url: location.href
              }
            }

            const style = document.createElement('style')
            style.textContent =
              '.AddressAutocomplete-results{display:none!important;height:0!important;overflow:hidden!important}'
            document.head.appendChild(style)

            const host = window.location.host
            const hostname = window.location.hostname.toLowerCase()
            const path = window.location.pathname
            const isStripeCheckoutSessionPath =
              /^\/(?:c\/)?pay\/cs_(?:live|test)_/i.test(path)
            const isStripeHostedPaymentPage =
              isStripeCheckoutSessionPath &&
              (hostname === 'pay.openai.com' ||
                hostname === 'checkout.stripe.com')
            log(`Host: ${host} Path: ${path}`)

            const currentStatus = getPaymentPageStatus()
            const statusResult = await handleCurrentPaymentStatus(currentStatus)
            if (statusResult) return statusResult

            if (isStripeHostedPaymentPage) {
              return handleStripeCheckoutPage()
            }

            if (
              host.includes('paypal.com') &&
              !path.includes('/checkoutweb/')
            ) {
              const accountPageResult = await handlePayPalAccountPage()
              if (accountPageResult) return accountPageResult
              const createAccountResult = await handlePayPalCreateAccountPage()
              if (createAccountResult) return createAccountResult
              const onboardingResult = await handlePayPalOnboardingPage()
              if (onboardingResult) return onboardingResult
              const loginResult = await handlePayPalUnifiedLoginPage()
              if (loginResult) return loginResult
            }

            if (host.includes('paypal.com') && path.includes('/checkoutweb/')) {
              return handlePayPalCheckoutSignupPage()
            }

            return handleGenericPaymentPage(
              currentStatus,
              isStripeHostedPaymentPage
            )
          },
          [assistConfig]
        )

        const selectedResult = selectPaymentAssistResult(frameResults)
        if (selectedResult) {
          return {
            ...selectedResult,
            frameResultCount: frameResults.length,
            frameKinds: frameResults
              .map((result) => {
                const kind = String(result?.kind || 'unknown')
                const frame = Number.isInteger(result?.frameId)
                  ? result.frameId
                  : -1
                return `${frame}:${kind}`
              })
              .slice(0, 12)
          }
        }
        return {
          kind: 'frame-scan',
          clickedAssistButton: false,
          clickResult: { clicked: false, reason: 'no_frame_result' },
          status: null,
          logs: [],
          url: '',
          frameResultCount: frameResults.length,
          frameKinds: []
        }
      }

      function scorePaymentPageStatus(status = {}) {
        let score = 0
        if (status.hasScaMultiField) score += 10000
        if (status.hasOtpInput) score += 9000
        if (status.hasConsentButton) score += 8000
        if (
          status.looksComplete &&
          status.frameId === 0 &&
          isCustomPayReturnUrl(status.url || '')
        ) {
          score += 7000
        }
        const host = String(status.host || '').toLowerCase()
        const path = String(status.path || '')
        if (host.includes('paypal.')) score += 500
        if (/checkout|billing|signin|sca|challenge|confirm|approve|pay/i.test(path)) {
          score += 100
        }
        if (status.readyState === 'complete') score += 10
        if (status.bodyTextPreview) score += 5
        if (status.frameId === 0) score += 1
        return score
      }

      function selectPaymentPageStatus(results = []) {
        const candidates = (Array.isArray(results) ? results : []).filter(
          (result) => result && typeof result === 'object'
        )
        if (!candidates.length) {
          return null
        }
        return candidates.sort(
          (left, right) =>
            scorePaymentPageStatus(right) - scorePaymentPageStatus(left)
        )[0]
      }

      async function inspectPaymentPage(tabId) {
        await waitForTabCompleteUntilStopped(tabId).catch(() => {})
        const frameResults = await runScriptInAllFrames(tabId, () => {
          function isVisible(element) {
            if (!element) return false
            const rect = element.getBoundingClientRect()
            const style = window.getComputedStyle(element)
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              !element.disabled &&
              style.visibility !== 'hidden' &&
              style.display !== 'none'
            )
          }
          function getControlText(element) {
            return String(
              element?.textContent ||
                element?.value ||
                element?.getAttribute?.('aria-label') ||
                ''
            )
              .replace(/\s+/g, ' ')
              .trim()
          }
          function isTextInput(element) {
            const type = String(element?.type || '').toLowerCase()
            return ['text', 'tel', 'number', 'password', ''].includes(type)
          }
          function isStripeHostedPaymentPageLocation() {
            const hostname = String(location.hostname || '').toLowerCase()
            const path = String(location.pathname || '')
            return (
              /^\/(?:c\/)?pay\/cs_(?:live|test)_/i.test(path) &&
              (hostname === 'pay.openai.com' || hostname === 'checkout.stripe.com')
            )
          }
          function isPayPalCheckoutSignupPage() {
            const host = String(location.host || '').toLowerCase()
            const path = String(location.pathname || '').toLowerCase()
            if (!host.includes('paypal.com') || !path.includes('/checkoutweb/')) {
              return false
            }
            return Boolean(
              document.querySelector(
                'select#country, select[name="country"], input#password, input[data-testid="lazy-password-input"], button[data-testid="submit-button"], button[data-atomic-wait-intent="click_select_create_account_and_continue"]'
              )
            )
          }
          const isStripeHostedPaymentPage = isStripeHostedPaymentPageLocation()
          const isCheckoutSignup = isPayPalCheckoutSignupPage()
          const isPayPalHost = String(location.host || '')
            .toLowerCase()
            .includes('paypal.com')
          const bodyText = String(document.body?.innerText || '')
            .replace(/\s+/g, ' ')
            .trim()
          const scaInputs =
            !isPayPalHost || isStripeHostedPaymentPage
              ? []
              : Array.from(
                  document.querySelectorAll(
                    '[data-testid="sca-confirm-multi-field"] input[name^="ciBasic-"], #ciBasic input[name^="ciBasic-"]'
                  )
                )
                  .filter((input) => isVisible(input))
                  .sort((left, right) =>
                    String(left.name || left.id || '').localeCompare(
                      String(right.name || right.id || '')
                    )
                  )
          const shouldIgnoreOtpStatus =
            isStripeHostedPaymentPage || isCheckoutSignup
          const otpInputs = shouldIgnoreOtpStatus
            ? []
            : Array.from(
                document.querySelectorAll('input, textarea')
              ).filter((input) => {
                const label = `${input.name || ''} ${input.id || ''} ${input.placeholder || ''} ${input.autocomplete || ''} ${input.getAttribute?.('aria-label') || ''}`
                const context = `${label} ${bodyText} ${location.href}`
                return (
                  isVisible(input) &&
                  !input.readOnly &&
                  isTextInput(input) &&
                  /(otp|code|token|verification|security|one[ -]?time|验证码|驗證|验证|代碼|代码)/i.test(
                    context
                  )
                )
              })

          const consentButton = isStripeHostedPaymentPage
            ? null
            : Array.from(
                document.querySelectorAll(
                  '#consentButton, button[data-testid="consentButton"], button, [role="button"], input[type="button"], input[type="submit"]'
                )
              ).find((candidate) => {
                const text = getControlText(candidate)
                const isExplicitConsent =
                  candidate.id === 'consentButton' ||
                  candidate.getAttribute?.('data-testid') === 'consentButton'
                return (
                  isVisible(candidate) &&
                  !candidate.disabled &&
                  (isExplicitConsent ||
                    (!isCheckoutSignup &&
                      /同意并继续|同意並繼續|agree\s*(?:and|&)?\s*continue/i.test(text)))
                )
              }) || null
          return {
            url: location.href,
            host: location.host,
            path: location.pathname,
            readyState: document.readyState,
            hasScaMultiField: scaInputs.length >= 6,
            scaInputCount: scaInputs.length,
            hasOtpInput: otpInputs.length > 0,
            otpInputCount: otpInputs.length,
            hasConsentButton: Boolean(consentButton),
            consentButtonText: getControlText(consentButton),
            looksComplete:
              /支付成功|付款成功|订阅成功|完成支付|已完成订阅|thank\s+you|payment\s+(?:succeeded|successful|completed)|paid\s+successfully/i.test(
                bodyText
              ),
            bodyTextPreview: bodyText.slice(0, 240)
          }
        })
        return (
          selectPaymentPageStatus(frameResults) || {
            url: '',
            host: '',
            path: '',
            readyState: '',
            hasScaMultiField: false,
            scaInputCount: 0,
            hasOtpInput: false,
            otpInputCount: 0,
            hasConsentButton: false,
            consentButtonText: '',
            looksComplete: false,
            bodyTextPreview: ''
          }
        )
      }

      function isPaymentPageDone(status = {}) {
        return isCustomPayPaymentCompleted(status)
      }

      function getPaymentPageHost(status = {}) {
        return String(status.host || '').toLowerCase().split(':')[0]
      }

      function isStripeHostedPaymentStatus(status = {}) {
        const hostname = getPaymentPageHost(status)
        const path = String(status.path || '')
        return (
          /^\/(?:c\/)?pay\/cs_(?:live|test)_/i.test(path) &&
          (hostname === 'pay.openai.com' || hostname === 'checkout.stripe.com')
        )
      }

      function isCustomPayPaymentCompleted(status = {}) {
        if (!status || typeof status !== 'object') {
          return false
        }
        if (status.frameId !== 0) {
          return false
        }
        return isCustomPayReturnUrl(status.url || '')
      }

      function getCustomPayAssistStage(result = {}, status = {}) {
        const effectiveStatus = status || {}
        if (isCustomPayPaymentCompleted(effectiveStatus)) {
          return {
            key: 'payment_completed',
            readyForStep9: true,
            completed: true,
            level: 'ok',
            message: '检测到支付页已完成或已回跳 ChatGPT。'
          }
        }
        if (effectiveStatus.hasScaMultiField) {
          return {
            key: 'paypal_otp_required',
            readyForStep9: true,
            level: 'ok',
            message: `已显示 PayPal 6 位短信验证码输入框，输入框=${effectiveStatus.scaInputCount || '已识别'}。`
          }
        }
        if (effectiveStatus.hasOtpInput) {
          return {
            key: 'paypal_otp_candidate_waiting',
            message: `检测到疑似验证码输入内容，继续等待 PayPal SCA 6 位输入框，当前输入框=${effectiveStatus.otpInputCount || '已识别'}。`
          }
        }
        if (effectiveStatus.hasConsentButton) {
          return {
            key: 'paypal_billing_consent_pending',
            message: `已进入 PayPal billing consent 页面，继续等待 PayPal SCA 验证码节点，按钮=${effectiveStatus.consentButtonText || 'Agree and Continue'}。`
          }
        }

        const kind = String(result?.kind || '')
        const reason = String(result?.clickResult?.reason || '')
        const url = String(result?.url || effectiveStatus.url || '')
        const clicked = Boolean(result?.clickedAssistButton || result?.clickResult?.clicked)
        const buttonText = String(result?.clickResult?.buttonText || '').trim()

        if (kind === 'stripe') {
          if (clicked) {
            return {
              key: 'stripe_paypal_selected',
              message: `已在 Stripe/支付方式页选择 PayPal${buttonText ? `（${buttonText}）` : ''}，等待进入 PayPal。`
            }
          }
          return {
            key: 'stripe_billing_filling',
            message: `正在填写支付方式页账单地址，country=${result?.countryValue || '未知'}，state=${result?.stateSelected ? '已选择' : '未选择'}。`
          }
        }

        if (kind === 'paypal-profile') {
          return {
            key: clicked ? 'paypal_profile_clicked' : 'paypal_profile_waiting',
            message: clicked
              ? `检测到 PayPal 已登录账号入口，已点击 profile${buttonText ? `（${buttonText}）` : ''}，等待进入退出登录页面。`
              : `检测到 PayPal 已登录账号入口，等待进入 profile${reason ? `（${reason}）` : ''}。`
          }
        }

        if (kind === 'paypal-logout') {
          return {
            key: clicked ? 'paypal_logout_clicked' : 'paypal_logout_waiting',
            message: clicked
              ? `已点击 PayPal 退出登录按钮${buttonText ? `（${buttonText}）` : ''}，等待回到登录/创建账户流程。`
              : `已进入 PayPal profile 页面，等待退出登录按钮可用${reason ? `（${reason}）` : ''}。`
          }
        }

        if (kind === 'paypal-login') {
          if (clicked) {
            return {
              key: 'paypal_create_account_clicked',
              message: `已点击 PayPal 创建账户按钮${buttonText ? `（${buttonText}）` : ''}，等待进入 onboarding 或 signup。`
            }
          }
          return {
            key: 'paypal_login_waiting',
            message: `已进入 PayPal checkout 登录页，等待创建账户按钮可用${reason ? `（${reason}）` : ''}。`
          }
        }

        if (kind === 'paypal-onboarding') {
          if (clicked) {
            return {
              key: 'paypal_onboarding_email_submitted',
              message: `已提交 PayPal onboarding 邮箱${buttonText ? `（${buttonText}）` : ''}，等待进入 checkoutweb/signup。`
            }
          }
          return {
            key: 'paypal_onboarding_waiting',
            message: `已进入 PayPal onboarding 页面，等待填写邮箱并继续${reason ? `（${reason}）` : ''}。`
          }
        }

        if (kind === 'paypal-checkout') {
          const complete = isPayPalCheckoutFormInfoComplete(result?.checkoutFormInfo || {})
          if (complete && clicked) {
            return {
              key: 'paypal_checkout_signup_submitted',
              message: `已提交 PayPal checkout signup 表单${buttonText ? `（${buttonText}）` : ''}，等待短信验证弹窗。`
            }
          }
          return {
            key: complete
              ? 'paypal_checkout_signup_ready'
              : 'paypal_checkout_signup_filling',
            message: complete
              ? 'PayPal checkout signup 表单已填写，等待同意继续按钮提交。'
              : `正在填写 PayPal checkout signup 表单，字段=${formatPayPalCheckoutFields(result?.checkoutFormInfo || {})}${formatMissingAssistConfig(result?.missingConfig || [])}。`
          }
        }

        if (kind === 'paypal-sca') {
          return {
            key: 'paypal_otp_required',
            readyForStep9: true,
            level: 'ok',
            message: '已进入 PayPal 验证码页面。'
          }
        }

        if (kind === 'paypal-consent') {
          return {
            key: 'paypal_billing_consent_pending',
            message: '已进入 PayPal billing consent 页面，继续等待 PayPal SCA 验证码节点。'
          }
        }

        if (/paypal\.com/i.test(url)) {
          return {
            key: 'paypal_opened',
            message: '已进入 PayPal 页面，正在识别登录、创建账户、signup 或验证码节点。'
          }
        }

        return {
          key: kind || 'payment_page_waiting',
          message: '正在等待支付页进入下一节点。'
        }
      }

      async function clearCustomPayManualConfirmationState(tabId) {
        const payload = {
          plusCheckoutTabId: tabId,
          plusManualConfirmationPending: false,
          plusManualConfirmationRequestId: '',
          plusManualConfirmationStep: 0,
          plusManualConfirmationMethod: '',
          plusManualConfirmationTitle: '',
          plusManualConfirmationMessage: ''
        }
        await setState(payload)
        if (typeof broadcastDataUpdate === 'function') {
          broadcastDataUpdate(payload)
        }
      }

      async function executeCustomPayPayPalAssist(state = {}) {
        const step = 8
        const tabId = await resolvePaymentTabId(state)
        if (chrome?.tabs?.update) {
          await chrome.tabs.update(tabId, { active: true }).catch(() => {})
        }
        await clearCustomPayManualConfirmationState(tabId)
        await addLog('步骤 8：正在自动处理 Custom Pay 支付页。', 'info', {
          step,
          stepKey: 'custom-pay-paypal-assist'
        })

        const startedAt = Date.now()
        let lastResult = null
        let lastStageKey = ''
        while (Date.now() - startedAt < CUSTOM_PAY_ASSIST_TIMEOUT_MS) {
          throwIfStopped()
          lastResult = await preparePayPalAssistPage(tabId, state)
          const rawStatus = lastResult?.status || (await inspectPaymentPage(tabId))
          const status =
            rawStatus && typeof rawStatus === 'object'
              ? {
                  ...rawStatus,
                  frameId: Number.isInteger(rawStatus.frameId)
                    ? rawStatus.frameId
                    : Number.isInteger(lastResult?.frameId)
                      ? lastResult.frameId
                      : -1,
                  documentId: rawStatus.documentId || lastResult?.documentId || ''
                }
              : rawStatus
          const stage = getCustomPayAssistStage(lastResult || {}, status || {})
          const addressInfo = lastResult?.addressInfo
          const addressText = addressInfo?.summary
            ? `，地址来源：${addressInfo.sourceText || addressInfo.source || '未知'}，美国地址：${addressInfo.summary}`
            : ''
          const frameText = Number.isInteger(lastResult?.frameId)
            ? `，frame=${lastResult.frameId}`
            : Number.isInteger(status?.frameId)
              ? `，frame=${status.frameId}`
              : ''
          const shouldLogDiagnostic =
            stage.key !== lastStageKey || lastResult?.clickedAssistButton
          if (shouldLogDiagnostic) {
            const frameCandidates = Array.isArray(lastResult?.frameKinds)
              ? `，frames=${lastResult.frameResultCount || lastResult.frameKinds.length}[${lastResult.frameKinds.join(', ')}]`
              : ''
            await addLog(
              `步骤 8 诊断：stage=${stage.key}，readyForStep9=${stage.readyForStep9 ? 'yes' : 'no'}，${formatCustomPayResultForLog(lastResult || {})}，${formatCustomPayStatusForLog(status || {})}${frameCandidates}`,
              stage.level || 'info',
              {
                step,
                stepKey: 'custom-pay-paypal-assist'
              }
            )
          }
          if (shouldLogDiagnostic) {
            lastStageKey = stage.key
            await addLog(
              `步骤 8：${stage.message}${addressText}${frameText}`,
              stage.level || 'info',
              {
                step,
                stepKey: 'custom-pay-paypal-assist'
              }
            )
          }
          if (stage.readyForStep9) {
            await clearCustomPayManualConfirmationState(tabId)
            await addLog(
              stage.completed
                ? '步骤 8：Custom Pay 支付页已完成，准备进入确认收尾。'
                : '步骤 8：已到达验证码或 PayPal 确认节点，准备进入 Step 9 串联处理。',
              'ok',
              {
                step,
                stepKey: 'custom-pay-paypal-assist'
              }
            )
            await addLog(
              `步骤 8 诊断：完成 Step 8 的原因 stage=${stage.key}，status=${formatCustomPayStatusForLog(status || {})}。`,
              'ok',
              {
                step,
                stepKey: 'custom-pay-paypal-assist'
              }
            )
            await completeStepFromBackground(step, {
              plusCheckoutTabId: tabId,
              plusCustomPayPayPalAssistCompletedAt: Date.now(),
              plusCustomPayPaymentPageStatus: status,
              plusCustomPayAssistStage: stage.key
            })
            return
          }
          await sleepWithStop(CUSTOM_PAY_ASSIST_SETTLE_MS)
        }

        throw new Error(
          `步骤 8：Custom Pay 支付页自动处理超时${lastResult?.status?.bodyTextPreview ? `（${lastResult.status.bodyTextPreview}）` : ''}。`
        )
      }

      async function openOrReuseOtpTab(otpUrl) {
        const registeredTabId = await getAliveRegisteredTabId(
          CUSTOM_PAY_OTP_SOURCE
        )
        if (registeredTabId) {
          await chrome.tabs
            .update(registeredTabId, { url: otpUrl, active: true })
            .catch(() => {})
          return registeredTabId
        }
        const tab =
          typeof createAutomationTab === 'function'
            ? await createAutomationTab({ url: otpUrl, active: true })
            : await chrome.tabs.create({ url: otpUrl, active: true })
        const tabId = Number(tab?.id) || 0
        if (!tabId) {
          throw new Error('步骤 9：打开 Custom Pay OTP 页面失败。')
        }
        if (typeof registerTab === 'function') {
          await registerTab(CUSTOM_PAY_OTP_SOURCE, tabId)
        }
        return tabId
      }

      async function readOtpCode(tabId) {
        await waitForTabCompleteUntilStopped(tabId).catch(() => {})
        await sleepWithStop(1000)
        await runScript(tabId, () => {
          const button = document.querySelector(
            '.panel-left .btn-confirm-token'
          )
          if (button) {
            button.scrollIntoView({ block: 'center', inline: 'center' })
            button.click()
          }
          return true
        })

        const startedAt = Date.now()
        while (Date.now() - startedAt < OTP_CODE_TIMEOUT_MS) {
          throwIfStopped()
          const result = await runScript(tabId, () => {
            function normalize(value) {
              return String(value || '')
                .replace(/\s+/g, ' ')
                .trim()
            }
            const selectors = [
              '.latest-code',
              '#latest-code',
              '[data-latest-code]',
              '[class*="latest-code"]'
            ]
            for (const selector of selectors) {
              const element = document.querySelector(selector)
              const text = normalize(
                element?.dataset?.latestCode ||
                  element?.textContent ||
                  element?.value ||
                  ''
              )
              if (text) {
                return { code: text }
              }
            }
            const candidates = Array.from(
              document.querySelectorAll('body *')
            ).slice(-300)
            for (const element of candidates) {
              const text = normalize(element.textContent || '')
              const match = text.match(
                /(?:latest[-_\s]*code|验证码|code)[:：\s]*([A-Za-z0-9]{4,12})/i
              )
              if (match?.[1]) {
                return { code: match[1] }
              }
            }
            return { code: '' }
          })
          const code = String(result?.code || '').trim()
          if (code) {
            return code
          }
          await sleepWithStop(POLL_INTERVAL_MS)
        }
        throw new Error('步骤 9：OTP 页面未读取到 latest-code。')
      }

      async function fillOtpOnPaymentPage(tabId, code) {
        await chrome.tabs.update(tabId, { active: true }).catch(() => {})
        await waitForTabCompleteUntilStopped(tabId).catch(() => {})
        await sleepWithStop(1000)
        const status = await inspectPaymentPage(tabId).catch(() => null)
        const frameId = Number.isInteger(status?.frameId) ? status.frameId : -1
        return runScriptInFrame(
          tabId,
          frameId,
          (otpCode) => {
            function isVisible(element) {
              if (!element) return false
              const rect = element.getBoundingClientRect()
              const style = window.getComputedStyle(element)
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                !element.disabled &&
                !element.readOnly &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
              )
            }
            function setValue(element, value) {
              const proto =
                element instanceof HTMLTextAreaElement
                  ? HTMLTextAreaElement.prototype
                  : HTMLInputElement.prototype
              const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
              if (descriptor?.set) {
                descriptor.set.call(element, value)
              } else {
                element.value = value
              }
              element.dispatchEvent(new Event('input', { bubbles: true }))
              element.dispatchEvent(new Event('change', { bubbles: true }))
            }
            const inputs = Array.from(
              document.querySelectorAll('input, textarea')
            )
            const multiFieldInputs = Array.from(
              document.querySelectorAll(
                '[data-testid="sca-confirm-multi-field"] input[name^="ciBasic-"], #ciBasic input[name^="ciBasic-"]'
              )
            )
              .filter((input) => isVisible(input))
              .sort((left, right) =>
                String(left.name || left.id || '').localeCompare(
                  String(right.name || right.id || '')
                )
              )
            if (multiFieldInputs.length >= otpCode.length) {
              const digits = String(otpCode || '')
                .replace(/\D/g, '')
                .split('')
              multiFieldInputs
                .slice(0, digits.length)
                .forEach((input, index) => {
                  input.focus()
                  setValue(input, digits[index])
                })
              const consentButton = document.querySelector(
                '#consentButton, button[data-testid="consentButton"]'
              )
              if (consentButton && isVisible(consentButton)) {
                consentButton.scrollIntoView({
                  block: 'center',
                  inline: 'center'
                })
                consentButton.click()
              }
              return {
                filled: true,
                confirmed: Boolean(consentButton),
                confirmButtonText: consentButton
                  ? String(
                      consentButton.textContent || consentButton.value || ''
                    ).trim()
                  : ''
              }
            }
            const preferred =
              inputs.find((input) => {
                const label = `${input.name || ''} ${input.id || ''} ${input.placeholder || ''} ${input.autocomplete || ''} ${input.getAttribute('aria-label') || ''}`
                return (
                  isVisible(input) &&
                  /(otp|code|token|verification|security|验证码|验证|代码)/i.test(
                    label
                  )
                )
              }) ||
              inputs.find(
                (input) =>
                  isVisible(input) &&
                  ['text', 'tel', 'number', 'password', ''].includes(
                    String(input.type || '').toLowerCase()
                  )
              )
            if (!preferred) {
              return {
                filled: false,
                confirmed: false,
                reason: 'input_not_found'
              }
            }
            preferred.focus()
            setValue(preferred, otpCode)

            const buttons = Array.from(
              document.querySelectorAll(
                'button, [role="button"], input[type="button"], input[type="submit"], a'
              )
            )
            const confirmButton = buttons.find((button) => {
              const text = String(
                button.textContent ||
                  button.value ||
                  button.getAttribute('aria-label') ||
                  ''
              )
                .replace(/\s+/g, ' ')
                .trim()
              return (
                isVisible(button) &&
                /(confirm|verify|submit|continue|next|确认|验证|提交|继续|下一步)/i.test(
                  text
                )
              )
            })
            if (confirmButton) {
              confirmButton.scrollIntoView({
                block: 'center',
                inline: 'center'
              })
              confirmButton.click()
            }
            return {
              filled: true,
              confirmed: Boolean(confirmButton),
              confirmButtonText: confirmButton
                ? String(
                    confirmButton.textContent || confirmButton.value || ''
                  ).trim()
                : ''
            }
          },
          [code]
        )
      }

      async function clickPaymentConsentIfPresent(tabId, options = {}) {
        const allowFinalPayment = Boolean(options.allowFinalPayment)
        await chrome.tabs.update(tabId, { active: true }).catch(() => {})
        await waitForTabCompleteUntilStopped(tabId).catch(() => {})
        await sleepWithStop(500)
        const status = await inspectPaymentPage(tabId).catch(() => null)
        const frameId = Number.isInteger(status?.frameId) ? status.frameId : -1
        return runScriptInFrame(
          tabId,
          frameId,
          (allowFinal) => {
            function isVisible(element) {
              if (!element) return false
              const rect = element.getBoundingClientRect()
              const style = window.getComputedStyle(element)
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                !element.disabled &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
              )
            }
            function getText(element) {
              return String(
                element?.textContent ||
                  element?.value ||
                  element?.getAttribute?.('aria-label') ||
                  ''
              )
                .replace(/\s+/g, ' ')
                .trim()
            }
            const finalPaymentPattern =
              /(^|\b)(pay|payment|pay now|complete order|place order|subscribe)(\b|$)|付款|支付|订阅/i
            const button =
              Array.from(
                document.querySelectorAll(
                  '#consentButton, button[data-testid="consentButton"], button, [role="button"], input[type="button"], input[type="submit"]'
                )
              ).find((candidate) => {
                const text = getText(candidate)
                return (
                  isVisible(candidate) &&
                  !candidate.disabled &&
                  (candidate.id === 'consentButton' ||
                    candidate.getAttribute?.('data-testid') ===
                      'consentButton' ||
                    /同意并继续|同意並繼續|agree\s*(?:and|&)?\s*continue|confirm|verify|submit|continue|next|确认|驗證|验证|提交|繼續|继续|下一步/i.test(
                      text
                    ) ||
                    (allowFinal && finalPaymentPattern.test(text)))
                )
              }) || null
            if (!button) {
              return { clicked: false }
            }
            const text = getText(button)
            button.scrollIntoView({ block: 'center', inline: 'center' })
            button.click()
            return { clicked: true, buttonText: text }
          },
          [allowFinalPayment]
        )
      }

      async function waitForOtpPostFillConfirmation(tabId, timeoutMs = 30000) {
        const startedAt = Date.now()
        let lastStatus = null
        while (Date.now() - startedAt < timeoutMs) {
          throwIfStopped()
          lastStatus = await inspectPaymentPage(tabId).catch(() => null)
          if (
            lastStatus &&
            !lastStatus.hasScaMultiField &&
            !lastStatus.hasConsentButton &&
            isPaymentPageDone(lastStatus)
          ) {
            return { confirmed: true, completed: true, status: lastStatus }
          }
          if (lastStatus && !lastStatus.hasScaMultiField) {
            const clickResult = await clickPaymentConsentIfPresent(tabId, {
              allowFinalPayment: true
            }).catch(() => ({ clicked: false }))
            if (clickResult?.clicked) {
              return {
                confirmed: true,
                clickResult,
                status: await inspectPaymentPage(tabId).catch(() => lastStatus)
              }
            }
          }
          await sleepWithStop(POLL_INTERVAL_MS)
        }
        return { confirmed: false, status: lastStatus }
      }

      async function waitForPaymentCompletion(tabId, timeoutMs = 20000) {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
          throwIfStopped()
          const status = await inspectPaymentPage(tabId)
          if (isPaymentPageDone(status)) {
            return { completed: true, status }
          }
          await sleepWithStop(POLL_INTERVAL_MS)
        }
        return {
          completed: false,
          status: await inspectPaymentPage(tabId).catch(() => null)
        }
      }

      async function executeCustomPayOtpConfirm(state = {}) {
        const step = 9
        const paymentTabId = await resolvePaymentTabId(state)
        await addLog(`步骤 9 诊断：paymentTab=${paymentTabId}。`, 'info', {
          step,
          stepKey: 'custom-pay-otp-confirm'
        })
        const initialStatus = await inspectPaymentPage(paymentTabId).catch(
          () => null
        )
        await addLog(
          `步骤 9 诊断：初始支付页状态：${formatCustomPayStatusForLog(initialStatus || {})}。`,
          'info',
          { step, stepKey: 'custom-pay-otp-confirm' }
        )
        if (initialStatus && !initialStatus.hasScaMultiField) {
          if (initialStatus.hasConsentButton) {
            await addLog(
              `步骤 9 诊断：未检测到 SCA，进入 PayPal 同意按钮分支：${formatCustomPayStatusForLog(initialStatus)}。`,
              'info',
              { step, stepKey: 'custom-pay-otp-confirm' }
            )
            const consentResult = await clickPaymentConsentIfPresent(
              paymentTabId,
              { allowFinalPayment: true }
            )
            await addLog(
              `步骤 9 诊断：同意按钮点击结果：${formatCustomPayClickForLog(consentResult)}。`,
              consentResult?.clicked ? 'ok' : 'warn',
              { step, stepKey: 'custom-pay-otp-confirm' }
            )
            if (!consentResult?.clicked) {
              throw new Error(
                '步骤 9：已识别到 PayPal 同意按钮，但自动点击失败，请手动确认后重试。'
              )
            }
            await addLog(
              `步骤 9：已点击 PayPal 同意按钮${consentResult.buttonText ? `（${consentResult.buttonText}）` : ''}。`,
              'ok',
              { step, stepKey: 'custom-pay-otp-confirm' }
            )
            const completion = await waitForPaymentCompletion(
              paymentTabId,
              60000
            )
            await addLog(
              `步骤 9 诊断：同意按钮后支付完成等待结果 completed=${completion.completed ? 'yes' : 'no'}，${formatCustomPayStatusForLog(completion.status || {})}。`,
              completion.completed ? 'ok' : 'warn',
              { step, stepKey: 'custom-pay-otp-confirm' }
            )
            if (!completion.completed) {
              const preview = String(
                completion?.status?.bodyTextPreview || ''
              ).slice(0, 120)
              throw new Error(
                `步骤 9：已点击 PayPal 同意按钮，但等待支付完成超时${preview ? `（页面：${preview}）` : ''}。`
              )
            }
            await completeStepFromBackground(step, {
              plusCustomPayOtpConfirmedAt: Date.now(),
              plusCustomPayPaymentPageStatus: completion.status
            })
            return
          }
          if (isPaymentPageDone(initialStatus)) {
            await addLog(
              `步骤 9 诊断：初始状态已完成：${formatCustomPayStatusForLog(initialStatus)}。`,
              'ok',
              { step, stepKey: 'custom-pay-otp-confirm' }
            )
            await addLog(
              '步骤 9：支付页已完成或已回跳，无需回填验证码。',
              'ok',
              { step, stepKey: 'custom-pay-otp-confirm' }
            )
            await completeStepFromBackground(step, {
              plusCustomPayOtpConfirmedAt: Date.now(),
              plusCustomPayPaymentPageStatus: initialStatus
            })
            return
          }
        }

        const otpUrl = String(state?.customPayOtpUrl || '').trim()
        if (!otpUrl) {
          throw new Error('步骤 9：请先在侧边栏配置 Custom Pay OTP 页面地址。')
        }
        await addLog(
          '步骤 9：正在打开 Custom Pay OTP 页面获取验证码...',
          'info',
          { step, stepKey: 'custom-pay-otp-confirm' }
        )
        await addLog(
          `步骤 9 诊断：OTP 页面=${formatSafeUrlForLog(otpUrl)}。`,
          'info',
          { step, stepKey: 'custom-pay-otp-confirm' }
        )
        const otpTabId = await openOrReuseOtpTab(otpUrl)
        await addLog(`步骤 9 诊断：otpTab=${otpTabId}。`, 'info', {
          step,
          stepKey: 'custom-pay-otp-confirm'
        })
        const code = await readOtpCode(otpTabId)
        await addLog(
          `步骤 9 诊断：读取到 OTP=${maskOtpCodeForLog(code)}。`,
          'ok',
          { step, stepKey: 'custom-pay-otp-confirm' }
        )
        await addLog('步骤 9：已读取 OTP 验证码，准备回填支付页。', 'ok', {
          step,
          stepKey: 'custom-pay-otp-confirm'
        })

        const result = await fillOtpOnPaymentPage(paymentTabId, code)
        await addLog(
          `步骤 9 诊断：OTP 回填结果 filled=${result?.filled ? 'yes' : 'no'}，confirmed=${result?.confirmed ? 'yes' : 'no'}，reason=${result?.reason || ''}${Number.isInteger(result?.frameId) ? `，frame=${result.frameId}` : ''}${result?.confirmButtonText ? `，button=${String(result.confirmButtonText).replace(/\s+/g, ' ').trim().slice(0, 80)}` : ''}。`,
          result?.filled ? 'ok' : 'warn',
          { step, stepKey: 'custom-pay-otp-confirm' }
        )
        if (!result?.filled) {
          throw new Error(
            '步骤 9：未识别到支付页验证码输入框，请手动回填后重试。'
          )
        }
        await addLog(
          `步骤 9：已回填 OTP 验证码${Number.isInteger(result.frameId) ? `，frame=${result.frameId}` : ''}${result.confirmed ? '，已触发页面内确认。' : '，等待跳转后的确认按钮。'}`,
          'ok',
          { step, stepKey: 'custom-pay-otp-confirm' }
        )
        let confirmResult = result?.confirmed
          ? {
              confirmed: true,
              clickResult: {
                clicked: true,
                buttonText: result.confirmButtonText || ''
              },
              status: await inspectPaymentPage(paymentTabId).catch(() => null)
            }
          : await waitForOtpPostFillConfirmation(paymentTabId)
        await addLog(
          `步骤 9 诊断：OTP 后确认结果 confirmed=${confirmResult?.confirmed ? 'yes' : 'no'}，completed=${confirmResult?.completed ? 'yes' : 'no'}，${formatCustomPayClickForLog(confirmResult?.clickResult || {})}，${formatCustomPayStatusForLog(confirmResult?.status || {})}。`,
          confirmResult?.confirmed ? 'ok' : 'warn',
          { step, stepKey: 'custom-pay-otp-confirm' }
        )
        if (!confirmResult?.confirmed) {
          const preview = String(
            confirmResult?.status?.bodyTextPreview || ''
          ).slice(0, 120)
          throw new Error(
            `步骤 9：验证码已回填，但等待跳转后的确认按钮超时${preview ? `（页面：${preview}）` : ''}。`
          )
        }
        await addLog(
          confirmResult.completed
            ? '步骤 9：验证码回填后支付页已完成或已回跳。'
            : `步骤 9：已点击跳转后的确认按钮${confirmResult.clickResult?.buttonText ? `（${confirmResult.clickResult.buttonText}）` : ''}${Number.isInteger(confirmResult.clickResult?.frameId) ? `，frame=${confirmResult.clickResult.frameId}` : ''}，等待支付完成。`,
          'ok',
          { step, stepKey: 'custom-pay-otp-confirm' }
        )
        const completion = confirmResult.completed
          ? { completed: true, status: confirmResult.status }
          : await waitForPaymentCompletion(paymentTabId, 60000)
        await addLog(
          `步骤 9 诊断：最终支付完成等待结果 completed=${completion.completed ? 'yes' : 'no'}，${formatCustomPayStatusForLog(completion.status || {})}。`,
          completion.completed ? 'ok' : 'warn',
          { step, stepKey: 'custom-pay-otp-confirm' }
        )
        if (!completion.completed) {
          const preview = String(
            completion?.status?.bodyTextPreview ||
              confirmResult?.status?.bodyTextPreview ||
              ''
          ).slice(0, 120)
          throw new Error(
            `步骤 9：验证码已回填并点击确认，但等待支付完成超时${preview ? `（页面：${preview}）` : ''}。`
          )
        }
        const buttonText =
          result.confirmButtonText ||
          confirmResult.clickResult?.buttonText ||
          ''
        await addLog(
          `步骤 9：验证码已回填并点击确认${buttonText ? `（${buttonText}）` : ''}。`,
          'ok',
          {
            step,
            stepKey: 'custom-pay-otp-confirm'
          }
        )
        await completeStepFromBackground(step, {
          plusCustomPayOtpConfirmedAt: Date.now(),
          plusCustomPayPaymentPageStatus:
            completion.status || confirmResult.status || null
        })
      }

      return {
        executeCustomPayGenerateHostedLink,
        executeCustomPayPayPalAssist,
        executeCustomPayOtpConfirm
      }
    }

    return {
      createCustomPayExecutor
    }
  }
)
