const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/custom-pay.js', 'utf8');

function loadModule() {
  const self = {};
  return new Function('self', `${source}; return self.MultiPageBackgroundCustomPay;`)(self);
}

test('Custom Pay assist does not complete from a non-main payment frame', async () => {
  const api = loadModule();
  const logs = [];
  const completed = [];
  let calls = 0;

  const executor = api.createCustomPayExecutor({
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      scripting: {
        executeScript: async ({ target }) => {
          calls += 1;
          assert.equal(target.allFrames, true);
          if (calls === 1) {
            return [
              {
                frameId: 0,
                result: {
                  kind: 'stripe',
                  clickedAssistButton: true,
                  clickResult: { clicked: true, buttonText: 'Subscribe' },
                  status: {
                    url: 'https://pay.openai.com/pay/cs_live_demo',
                    host: 'pay.openai.com',
                    path: '/pay/cs_live_demo',
                    looksComplete: false,
                  },
                  logs: [],
                  url: 'https://pay.openai.com/pay/cs_live_demo',
                },
              },
              {
                frameId: 3849,
                result: {
                  kind: 'complete',
                  clickedAssistButton: false,
                  clickResult: { clicked: false },
                  status: {
                    url: 'https://pay.openai.com/return/complete',
                    host: 'pay.openai.com',
                    path: '/return/complete',
                    looksComplete: true,
                  },
                  logs: [],
                  url: 'https://pay.openai.com/return/complete',
                },
              },
            ];
          }
          return [
            {
              frameId: 0,
              result: {
                kind: 'generic',
                clickedAssistButton: false,
                clickResult: { clicked: false },
                status: {
                  url: 'https://chatgpt.com/',
                  host: 'chatgpt.com',
                  path: '/',
                  looksComplete: false,
                },
                logs: [],
                url: 'https://chatgpt.com/',
              },
            },
          ];
        },
      },
      tabs: {
        update: async () => ({}),
      },
    },
    completeStepFromBackground: async (step, payload) => {
      completed.push({ step, payload });
    },
    getTabId: async () => 1,
    isTabAlive: async () => true,
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executeCustomPayPayPalAssist({});

  assert.equal(calls, 2);
  assert.deepEqual(completed.map((item) => item.step), [8]);
  assert.equal(completed[0].payload.plusCustomPayAssistStage, 'payment_completed');
  assert.equal(completed[0].payload.plusCustomPayPaymentPageStatus.frameId, 0);
  assert.equal(logs.some(({ message }) => message.includes('frame=3849') && message.includes('检测到支付页已完成')), false);
});
test('Custom Pay assist selects the PayPal checkout frame from all frame results', async () => {
  const api = loadModule();
  const logs = [];
  const completed = [];
  const stateUpdates = [];
  const executeTargets = [];

  const executor = api.createCustomPayExecutor({
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      scripting: {
        executeScript: async ({ target }) => {
          executeTargets.push(target);
          assert.equal(target.allFrames, true);
          return [
            {
              frameId: 0,
              result: {
                kind: 'generic',
                clickedAssistButton: true,
                clickResult: { clicked: true, buttonText: 'Continue' },
                countrySelected: false,
                status: {
                  host: 'www.paypal.com',
                  hasScaMultiField: false,
                  hasConsentButton: false,
                  looksComplete: false,
                },
                logs: [],
                url: 'https://www.paypal.com/checkoutweb/demo',
              },
            },
            {
              frameId: 7,
              result: {
                kind: 'paypal-checkout',
                clickedAssistButton: false,
                clickResult: { clicked: false, reason: 'form_not_filled' },
                countrySelected: true,
                countryValue: 'US',
                stateSelected: true,
                checkoutFormInfo: {
                  emailFilled: true,
                  phoneFilled: true,
                  cardNumberFilled: false,
                  cardExpiryFilled: true,
                  cardCvvFilled: true,
                  passwordFilled: true,
                  firstNameFilled: true,
                  lastNameFilled: true,
                  line1Filled: true,
                  cityFilled: true,
                  postalFilled: true,
                },
                missingConfig: ['cardNumber'],
                status: {
                  host: 'www.paypal.com',
                  hasScaMultiField: true,
                  hasConsentButton: false,
                  looksComplete: false,
                },
                addressInfo: {
                  source: 'builtin_us_fallback',
                  sourceText: '内置美国地址池',
                  summary: 'Charlotte, North Carolina 28202',
                },
                logs: [],
                url: 'https://www.paypal.com/checkoutweb/demo',
              },
            },
          ];
        },
      },
      tabs: {
        update: async () => ({}),
      },
    },
    completeStepFromBackground: async (step, payload) => {
      completed.push({ step, payload });
    },
    getTabId: async () => 1,
    isTabAlive: async () => true,
    setState: async (payload) => {
      stateUpdates.push(payload);
    },
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executeCustomPayPayPalAssist({
    customPayAssistPhone: '15555550123',
    customPayCardExpiry: '12/30',
    customPayCardCvv: '123',
  });

  assert.equal(executeTargets.length, 1);
  assert.deepEqual(completed.map((item) => item.step), [8]);
  assert.equal(completed[0].payload.plusCustomPayAssistStage, 'paypal_otp_required');
  assert.equal(stateUpdates.length > 0, true);
  assert.equal(logs.some(({ message }) => message.includes('frame=7')), true);
  assert.equal(logs.some(({ message }) => message.includes('已显示 PayPal 6 位短信验证码输入框')), true);
  assert.equal(logs.some(({ message }) => message.includes('准备进入 Step 9 串联处理')), true);
});

class FakeElement {
  constructor(tagName, attrs = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attrs = { ...attrs };
    this.id = attrs.id || '';
    this.name = attrs.name || '';
    this.type = attrs.type || '';
    this.action = attrs.action || '';
    this.placeholder = attrs.placeholder || '';
    this.autocomplete = attrs.autocomplete || '';
    this.value = attrs.value || '';
    this.textContent = text;
    this.dataset = Object.fromEntries(
      Object.entries(attrs)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value])
    );
    this.disabled = false;
    this.hidden = false;
    this.style = {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      setProperty: (key, value) => {
        this.style[key] = value;
      },
    };
    this.clickCount = 0;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(key) {
    if (key === 'id') return this.id;
    if (key === 'name') return this.name;
    if (key === 'type') return this.type;
    if (key === 'action') return this.action;
    if (key === 'placeholder') return this.placeholder;
    if (key === 'autocomplete') return this.autocomplete;
    if (key === 'value') return this.value;
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }

  get classList() {
    const classes = String(this.attrs.class || '').split(/\s+/).filter(Boolean);
    return { contains: (name) => classes.includes(name) };
  }

  getBoundingClientRect() {
    return { width: 160, height: 40, left: 0, top: 0 };
  }

  scrollIntoView() {}
  focus() {}
  blur() {}
  dispatchEvent() { return true; }
  click() { this.clickCount += 1; }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const selectors = String(selector || '').split(',').map((item) => item.trim()).filter(Boolean);
    const descendants = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        descendants.push(child);
        visit(child);
      });
    };
    visit(this);
    return descendants.filter((element) => selectors.some((item) => matchesSelector(element, item)));
  }
}

function matchesSelector(element, selector) {
  const normalized = String(selector || '').replace(/\\:/g, ':').trim();
  if (!normalized) return false;
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    let current = element;
    if (!matchesSimpleSelector(current, parts[parts.length - 1])) return false;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      current = current.parentElement;
      while (current && !matchesSimpleSelector(current, parts[index])) {
        current = current.parentElement;
      }
      if (!current) return false;
    }
    return true;
  }
  return matchesSimpleSelector(element, normalized);
}

function matchesSimpleSelector(element, selector) {
  if (!element || !selector) return false;
  const tagMatch = selector.match(/^[a-z]+/i);
  if (tagMatch && element.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
  const idMatch = selector.match(/#([\w-]+)/);
  if (idMatch && element.id !== idMatch[1]) return false;
  const classMatches = [...selector.matchAll(/\.([\w:-]+)/g)].map((match) => match[1]);
  for (const className of classMatches) {
    if (!element.classList.contains(className)) return false;
  }
  const attrMatches = [...selector.matchAll(/\[([^\]=~*^$\s]+)\s*([*^$]?=)?\s*"?([^"\]\s]*)"?(?:\s+[is])?\]/g)];
  for (const [, rawName, operator, expected] of attrMatches) {
    const rawActual = element.getAttribute(rawName.trim());
    if (!operator) {
      if (rawActual === null) return false;
      continue;
    }
    const actual = String(rawActual || '');
    if (operator === '=' && actual !== expected) return false;
    if (operator === '*=' && !actual.includes(expected)) return false;
    if (operator === '^=' && !actual.startsWith(expected)) return false;
    if (operator === '$=' && !actual.endsWith(expected)) return false;
  }
  return Boolean(tagMatch || idMatch || classMatches.length || attrMatches.length);
}

function createFakeSelect(SelectClass, attrs = {}, options = []) {
  const select = new SelectClass('select', attrs);
  let currentValue = attrs.value || '';
  select.options = options.map((option) => ({
    value: option.value,
    text: option.text,
  }));
  Object.defineProperty(select, 'value', {
    get() {
      return currentValue;
    },
    set(value) {
      currentValue = String(value || '');
      const index = select.options.findIndex((option) => String(option.value) === currentValue);
      select.selectedIndex = index >= 0 ? index : -1;
    },
  });
  select.selectedIndex = select.options.findIndex((option) => option.value === currentValue);
  if (select.selectedIndex < 0) select.selectedIndex = 0;
  select.value = select.options[select.selectedIndex]?.value || '';
  return select;
}

async function withPayPalCheckoutSignupDom(operation) {
  const originals = new Map();
  const setGlobal = (key, value) => {
    originals.set(key, {
      exists: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
    globalThis[key] = value;
  };
  const restoreGlobals = () => {
    for (const [key, original] of originals) {
      if (original.exists) {
        globalThis[key] = original.value;
      } else {
        delete globalThis[key];
      }
    }
  };

  class FakeHTMLElement extends FakeElement {}
  class FakeHTMLInputElement extends FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  class FakeHTMLTextAreaElement extends FakeHTMLElement {}
  class FakeEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }

  const documentElement = new FakeHTMLElement('html');
  const head = new FakeHTMLElement('head');
  const body = new FakeHTMLElement('body');
  const form = new FakeHTMLElement('form', { id: 'weasleyContainer' });
  const country = createFakeSelect(FakeHTMLSelectElement, { id: 'country', name: 'country' }, [
    { value: '', text: 'Country/Region' },
    { value: 'US', text: 'United States' },
  ]);
  const phoneType = createFakeSelect(FakeHTMLSelectElement, { id: 'phoneType', name: 'phoneType' }, [
    { value: '', text: 'Type' },
    { value: 'MOBILE', text: 'Mobile' },
  ]);
  const dialingCode = createFakeSelect(FakeHTMLSelectElement, { id: 'dialingCode', name: 'dialingCode' }, [
    { value: '', text: 'Code' },
    { value: 'US', text: '+1 United States' },
  ]);
  const billingState = createFakeSelect(FakeHTMLSelectElement, { id: 'billingState', name: 'billingState' }, [
    { value: '', text: 'State' },
    { value: 'NC', text: 'North Carolina' },
  ]);
  const emailInput = new FakeHTMLInputElement('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'email' });
  const phoneInput = new FakeHTMLInputElement('input', { id: 'phone', name: 'phone', type: 'tel', autocomplete: 'tel', 'data-testid': 'phone' });
  const cardNumberInput = new FakeHTMLInputElement('input', { id: 'cardNumber', name: 'cardnumber', autocomplete: 'cc-number' });
  const cardExpiryInput = new FakeHTMLInputElement('input', { id: 'cardExpiry', name: 'exp-date', autocomplete: 'cc-exp' });
  const cardCvvInput = new FakeHTMLInputElement('input', { id: 'cardCvv', name: 'cvv', autocomplete: 'cc-csc' });
  const firstNameInput = new FakeHTMLInputElement('input', { id: 'firstName', name: 'fname', autocomplete: 'given-name' });
  const lastNameInput = new FakeHTMLInputElement('input', { id: 'lastName', name: 'lname', autocomplete: 'family-name' });
  const line1Input = new FakeHTMLInputElement('input', { id: 'billingLine1', name: 'billingLine1', autocomplete: 'address-line1' });
  const cityInput = new FakeHTMLInputElement('input', { id: 'billingCity', name: 'billingCity', autocomplete: 'address-level2' });
  const postalInput = new FakeHTMLInputElement('input', { id: 'billingPostalCode', name: 'billingPostalCode', autocomplete: 'postal-code' });
  const passwordInput = new FakeHTMLInputElement('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'new-password', 'data-testid': 'lazy-password-input' });
  const submitButton = new FakeHTMLElement('button', {
    type: 'submit',
    'data-testid': 'submit-button',
    'data-atomic-wait-intent': 'click_select_create_account_and_continue',
  }, 'Agree & Create Account');

  documentElement.appendChild(head);
  documentElement.appendChild(body);
  body.appendChild(form);
  [
    country,
    emailInput,
    phoneType,
    dialingCode,
    phoneInput,
    cardNumberInput,
    cardExpiryInput,
    cardCvvInput,
    firstNameInput,
    lastNameInput,
    line1Input,
    cityInput,
    billingState,
    postalInput,
    passwordInput,
    submitButton,
  ].forEach((element) => form.appendChild(element));

  const findById = (id) => documentElement.querySelector(`#${id}`);
  const document = {
    readyState: 'complete',
    documentElement,
    head,
    body,
    activeElement: null,
    createElement: (tagName) => new FakeHTMLElement(tagName),
    getElementById: findById,
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    dispatchEvent: () => true,
  };
  body.innerText = 'PayPal checkout signup PayPal will text you a code to verify this number. Agree & Create Account';
  body.textContent = body.innerText;

  [
    emailInput,
    phoneInput,
    cardNumberInput,
    cardExpiryInput,
    cardCvvInput,
    firstNameInput,
    lastNameInput,
    line1Input,
    cityInput,
    postalInput,
    passwordInput,
  ].forEach((input) => {
    input.focus = () => { document.activeElement = input; };
    input.blur = () => { if (document.activeElement === input) document.activeElement = null; };
  });

  const storage = new Map([
    ['customPayUsAddress', JSON.stringify({
      street: '100 N Tryon St',
      city: 'Charlotte',
      state: 'North Carolina',
      zip: '28202',
      source: 'test_cache',
      sourceText: '测试地址',
    })],
  ]);
  const location = {
    href: 'https://www.paypal.com/checkoutweb/signup?token=BA-demo',
    host: 'www.paypal.com',
    hostname: 'www.paypal.com',
    pathname: '/checkoutweb/signup',
  };
  const window = {
    location,
    getComputedStyle: (element) => element?.style || { display: 'block', visibility: 'visible', opacity: '1' },
  };

  setGlobal('HTMLElement', FakeHTMLElement);
  setGlobal('HTMLInputElement', FakeHTMLInputElement);
  setGlobal('HTMLSelectElement', FakeHTMLSelectElement);
  setGlobal('HTMLTextAreaElement', FakeHTMLTextAreaElement);
  setGlobal('Event', FakeEvent);
  setGlobal('MouseEvent', FakeEvent);
  setGlobal('KeyboardEvent', FakeEvent);
  setGlobal('InputEvent', FakeEvent);
  setGlobal('document', document);
  setGlobal('window', window);
  setGlobal('location', location);
  setGlobal('sessionStorage', {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => { storage.set(key, String(value)); },
  });
  setGlobal('setTimeout', (callback) => {
    callback();
    return 0;
  });

  try {
    return await operation({
      billingState,
      cardCvvInput,
      cardExpiryInput,
      cardNumberInput,
      cityInput,
      country,
      firstNameInput,
      lastNameInput,
      line1Input,
      passwordInput,
      phoneInput,
      postalInput,
      submitButton,
    });
  } finally {
    restoreGlobals();
  }
}

async function withPayPalUnifiedLoginDom(operation) {
  const originals = new Map();
  const setGlobal = (key, value) => {
    originals.set(key, {
      exists: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
    globalThis[key] = value;
  };
  const restoreGlobals = () => {
    for (const [key, original] of originals) {
      if (original.exists) {
        globalThis[key] = original.value;
      } else {
        delete globalThis[key];
      }
    }
  };

  class FakeHTMLElement extends FakeElement {}
  class FakeHTMLInputElement extends FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  class FakeHTMLTextAreaElement extends FakeHTMLElement {}
  class FakeEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }

  const documentElement = new FakeHTMLElement('html');
  const head = new FakeHTMLElement('head');
  const body = new FakeHTMLElement('body');
  const content = new FakeHTMLElement('div', { id: 'content', class: 'contentContainer activeContent contentContainerBordered' });
  const form = new FakeHTMLElement('form', {
    action: '/signin?intent=checkout&ctxId=xo_ctx_demo&returnUri=%2Fwebapps%2Fhermes&state=demo',
    method: 'post',
    class: 'proceed maskable',
    name: 'login',
  });
  const nextButton = new FakeHTMLElement('button', { id: 'btnNext', name: 'btnNext', type: 'submit', value: 'Next' }, '下一頁');
  const signupContainer = new FakeHTMLElement('div', { id: 'signupContainer', class: 'signupContainer', 'data-hide-on-email': '', 'data-hide-on-pass': '' });
  const createButton = new FakeHTMLElement('button', {
    id: 'startOnboardingFlow',
    type: 'button',
    class: 'button secondary scTrack:unifiedlogin-click-signup-button onboardingFlowContentKey',
  }, '建立帳戶');

  documentElement.appendChild(head);
  documentElement.appendChild(body);
  body.appendChild(content);
  content.appendChild(form);
  form.appendChild(nextButton);
  content.appendChild(signupContainer);
  signupContainer.appendChild(createButton);

  const document = {
    readyState: 'complete',
    documentElement,
    head,
    body,
    createElement: (tagName) => new FakeHTMLElement(tagName),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    dispatchEvent: () => true,
  };
  body.innerText = '下一頁 或者 建立帳戶';
  body.textContent = body.innerText;

  const location = {
    href: 'https://www.paypal.com/signin?intent=checkout',
    host: 'www.paypal.com',
    hostname: 'www.paypal.com',
    pathname: '/signin',
  };
  const window = {
    location,
    getComputedStyle: (element) => element?.style || { display: 'block', visibility: 'visible', opacity: '1' },
  };

  setGlobal('HTMLElement', FakeHTMLElement);
  setGlobal('HTMLInputElement', FakeHTMLInputElement);
  setGlobal('HTMLSelectElement', FakeHTMLSelectElement);
  setGlobal('HTMLTextAreaElement', FakeHTMLTextAreaElement);
  setGlobal('Event', FakeEvent);
  setGlobal('MouseEvent', FakeEvent);
  setGlobal('KeyboardEvent', FakeEvent);
  setGlobal('InputEvent', FakeEvent);
  setGlobal('document', document);
  setGlobal('window', window);
  setGlobal('location', location);
  setGlobal('setTimeout', (callback) => {
    callback();
    return 0;
  });

  try {
    return await operation({ createButton, nextButton });
  } finally {
    restoreGlobals();
  }
}

async function withPayPalPayCreateAccountDom(operation) {
  const originals = new Map();
  const setGlobal = (key, value) => {
    originals.set(key, {
      exists: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
    globalThis[key] = value;
  };
  const restoreGlobals = () => {
    for (const [key, original] of originals) {
      if (original.exists) {
        globalThis[key] = original.value;
      } else {
        delete globalThis[key];
      }
    }
  };

  class FakeHTMLElement extends FakeElement {}
  class FakeHTMLInputElement extends FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  class FakeHTMLTextAreaElement extends FakeHTMLElement {}
  class FakeEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }

  const documentElement = new FakeHTMLElement('html');
  const head = new FakeHTMLElement('head');
  const body = new FakeHTMLElement('body');
  const loginForm = new FakeHTMLElement('form', { method: 'post', action: '/pay' });
  const emailInput = new FakeHTMLInputElement('input', { id: 'email', name: 'login_email', type: 'email', autocomplete: 'username' });
  const passwordInput = new FakeHTMLInputElement('input', { id: 'password', name: 'login_password', type: 'password', autocomplete: 'current-password' });
  const loginButton = new FakeHTMLElement('button', { type: 'submit', name: 'action', value: 'submitPassword' }, 'Log In');
  const onboardingForm = new FakeHTMLElement('form', { 'data-testid': 'xo-onboarding-form', class: 'w-full' });
  const createButton = new FakeHTMLElement('button', { type: 'submit' }, 'Create an Account');
  const createButtonLabel = new FakeHTMLElement('span', {}, 'Create an Account');

  documentElement.appendChild(head);
  documentElement.appendChild(body);
  body.appendChild(loginForm);
  loginForm.appendChild(emailInput);
  loginForm.appendChild(passwordInput);
  loginForm.appendChild(loginButton);
  body.appendChild(onboardingForm);
  onboardingForm.appendChild(createButton);
  createButton.appendChild(createButtonLabel);

  const document = {
    readyState: 'complete',
    documentElement,
    head,
    body,
    createElement: (tagName) => new FakeHTMLElement(tagName),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    dispatchEvent: () => true,
  };
  body.innerText = 'Log In Create an Account';
  body.textContent = body.innerText;

  const location = {
    href: 'https://www.paypal.com/pay/?ul=1',
    host: 'www.paypal.com',
    hostname: 'www.paypal.com',
    pathname: '/pay/',
  };
  const window = {
    location,
    getComputedStyle: (element) => element?.style || { display: 'block', visibility: 'visible', opacity: '1' },
  };

  setGlobal('HTMLElement', FakeHTMLElement);
  setGlobal('HTMLInputElement', FakeHTMLInputElement);
  setGlobal('HTMLSelectElement', FakeHTMLSelectElement);
  setGlobal('HTMLTextAreaElement', FakeHTMLTextAreaElement);
  setGlobal('Event', FakeEvent);
  setGlobal('MouseEvent', FakeEvent);
  setGlobal('KeyboardEvent', FakeEvent);
  setGlobal('InputEvent', FakeEvent);
  setGlobal('document', document);
  setGlobal('window', window);
  setGlobal('location', location);
  setGlobal('setTimeout', (callback) => {
    callback();
    return 0;
  });

  try {
    return await operation({ createButton, loginButton });
  } finally {
    restoreGlobals();
  }
}

async function withPayPalOnboardingDom(operation) {
  const originals = new Map();
  const setGlobal = (key, value) => {
    originals.set(key, {
      exists: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
    globalThis[key] = value;
  };
  const restoreGlobals = () => {
    for (const [key, original] of originals) {
      if (original.exists) {
        globalThis[key] = original.value;
      } else {
        delete globalThis[key];
      }
    }
  };

  class FakeHTMLElement extends FakeElement {}
  class FakeHTMLInputElement extends FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  class FakeHTMLTextAreaElement extends FakeHTMLElement {}
  class FakeEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }

  const documentElement = new FakeHTMLElement('html');
  const head = new FakeHTMLElement('head');
  const body = new FakeHTMLElement('body');
  const section = new FakeHTMLElement('section', { id: 'onboardingFlow', class: 'contentAlignment onboardingFlow', 'data-role': 'page' });
  const content = new FakeHTMLElement('div', { id: 'content', class: 'contentContainer activeContent contentContainerBordered' });
  const form = new FakeHTMLElement('form', {
    action: '/signin/onboarding/continue',
    method: 'post',
    class: 'proceed maskable',
    name: 'beginOnboardingFlow',
  });
  const emailInput = new FakeHTMLInputElement('input', {
    id: 'onboardingFlowEmail',
    name: 'login_email',
    type: 'email',
    placeholder: '輸入電郵',
  });
  const continueButton = new FakeHTMLElement('button', {
    type: 'submit',
    class: 'button actionContinue scTrack:next',
  }, '繼續付款');

  documentElement.appendChild(head);
  documentElement.appendChild(body);
  body.appendChild(section);
  section.appendChild(content);
  content.appendChild(form);
  form.appendChild(emailInput);
  form.appendChild(continueButton);

  const document = {
    readyState: 'complete',
    documentElement,
    head,
    body,
    createElement: (tagName) => new FakeHTMLElement(tagName),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    dispatchEvent: () => true,
  };
  body.innerText = '建立 PayPal 帳戶 繼續付款';
  body.textContent = body.innerText;

  const location = {
    href: 'https://www.paypal.com/agreements/approve?ba_token=BA-demo',
    host: 'www.paypal.com',
    hostname: 'www.paypal.com',
    pathname: '/agreements/approve',
  };
  const window = {
    location,
    getComputedStyle: (element) => element?.style || { display: 'block', visibility: 'visible', opacity: '1' },
  };

  setGlobal('HTMLElement', FakeHTMLElement);
  setGlobal('HTMLInputElement', FakeHTMLInputElement);
  setGlobal('HTMLSelectElement', FakeHTMLSelectElement);
  setGlobal('HTMLTextAreaElement', FakeHTMLTextAreaElement);
  setGlobal('Event', FakeEvent);
  setGlobal('MouseEvent', FakeEvent);
  setGlobal('KeyboardEvent', FakeEvent);
  setGlobal('InputEvent', FakeEvent);
  setGlobal('document', document);
  setGlobal('window', window);
  setGlobal('location', location);
  setGlobal('setTimeout', (callback) => {
    callback();
    return 0;
  });

  try {
    return await operation({ continueButton, emailInput });
  } finally {
    restoreGlobals();
  }
}

async function withPayPalScaDom(operation) {
  const originals = new Map();
  const setGlobal = (key, value) => {
    originals.set(key, {
      exists: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
    globalThis[key] = value;
  };
  const restoreGlobals = () => {
    for (const [key, original] of originals) {
      if (original.exists) {
        globalThis[key] = original.value;
      } else {
        delete globalThis[key];
      }
    }
  };

  class FakeHTMLElement extends FakeElement {}
  class FakeHTMLInputElement extends FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  class FakeHTMLTextAreaElement extends FakeHTMLElement {}
  class FakeEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }

  const documentElement = new FakeHTMLElement('html');
  const head = new FakeHTMLElement('head');
  const body = new FakeHTMLElement('body');
  const scaRoot = new FakeHTMLElement('div', { 'data-testid': 'sca-confirm-multi-field' });
  const heading = new FakeHTMLElement('h1', {}, 'Enter your code');
  const inputs = Array.from({ length: 6 }, (_, index) => new FakeHTMLInputElement('input', {
    id: `ci-ciBasic-${index}`,
    name: `ciBasic-${index}`,
    type: 'tel',
  }));

  documentElement.appendChild(head);
  documentElement.appendChild(body);
  body.appendChild(scaRoot);
  scaRoot.appendChild(heading);
  inputs.forEach((input) => scaRoot.appendChild(input));

  const document = {
    readyState: 'complete',
    documentElement,
    head,
    body,
    createElement: (tagName) => new FakeHTMLElement(tagName),
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    dispatchEvent: () => true,
  };
  body.innerText = 'Enter your code';
  body.textContent = body.innerText;

  const location = {
    href: 'https://www.paypal.com/checkoutweb/signup?token=BA-demo&sca=1',
    host: 'www.paypal.com',
    hostname: 'www.paypal.com',
    pathname: '/checkoutweb/signup',
  };
  const window = {
    location,
    getComputedStyle: (element) => element?.style || { display: 'block', visibility: 'visible', opacity: '1' },
  };

  setGlobal('HTMLElement', FakeHTMLElement);
  setGlobal('HTMLInputElement', FakeHTMLInputElement);
  setGlobal('HTMLSelectElement', FakeHTMLSelectElement);
  setGlobal('HTMLTextAreaElement', FakeHTMLTextAreaElement);
  setGlobal('Event', FakeEvent);
  setGlobal('MouseEvent', FakeEvent);
  setGlobal('KeyboardEvent', FakeEvent);
  setGlobal('InputEvent', FakeEvent);
  setGlobal('document', document);
  setGlobal('window', window);
  setGlobal('location', location);
  setGlobal('setTimeout', (callback) => {
    callback();
    return 0;
  });

  try {
    return await operation({ inputs });
  } finally {
    restoreGlobals();
  }
}

test('Custom Pay assist clicks the PayPal unifiedlogin create-account button instead of Next', async () => {
  const api = loadModule();
  const completed = [];
  const logs = [];
  const frameResults = [];

  let calls = 0;

  const executor = api.createCustomPayExecutor({
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      scripting: {
        executeScript: async ({ target, func, args = [] }) => {
          assert.equal(target.tabId, 1);
          calls += 1;
          if (calls === 1) {
            const result = await withPayPalUnifiedLoginDom(async ({ createButton, nextButton }) => {
              const value = await func(...args);
              return {
                ...value,
                createButtonClickCount: createButton.clickCount,
                nextButtonClickCount: nextButton.clickCount,
              };
            });
            frameResults.push(result);
            return [{ frameId: target.frameIds?.[0] || 0, result: { ...result, status: { ...result.status, host: 'www.paypal.com' } } }];
          }
          const result = await withPayPalScaDom(async () => func(...args));
          frameResults.push(result);
          return [{ frameId: target.frameIds?.[0] || 0, result: { ...result, status: { ...result.status, host: 'www.paypal.com' } } }];
        },
      },
      tabs: {
        update: async () => ({}),
      },
    },
    completeStepFromBackground: async (step, payload) => {
      completed.push({ step, payload });
    },
    getTabId: async () => 1,
    isTabAlive: async () => true,
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executeCustomPayPayPalAssist({});

  assert.equal(frameResults.length, 2);
  assert.equal(frameResults[0].kind, 'paypal-login');
  assert.equal(frameResults[0].createButtonClickCount, 1);
  assert.equal(frameResults[0].nextButtonClickCount, 0);
  assert.equal(frameResults[0].clickedAssistButton, true);
  assert.equal(frameResults[0].clickResult.buttonId, 'startOnboardingFlow');
  assert.equal(frameResults[0].clickResult.buttonText, '建立帳戶');
  assert.equal(frameResults[1].kind, 'paypal-sca');
  assert.equal(frameResults[1].status.hasScaMultiField, true);
  assert.equal(frameResults[1].status.scaInputCount, 6);
  assert.deepEqual(completed.map((item) => item.step), [8]);
  assert.equal(completed[0].payload.plusCustomPayAssistStage, 'paypal_otp_required');
  assert.equal(frameResults[0].logs.some((message) => message.includes('已点击 PayPal 创建账户按钮：建立帳戶')), true);
});

test('Custom Pay assist clicks the PayPal /pay create-account button instead of Log In', async () => {
  const api = loadModule();
  const completed = [];
  const logs = [];
  const frameResults = [];

  let calls = 0;

  const executor = api.createCustomPayExecutor({
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      scripting: {
        executeScript: async ({ target, func, args = [] }) => {
          assert.equal(target.tabId, 1);
          calls += 1;
          if (calls === 1) {
            const result = await withPayPalPayCreateAccountDom(async ({ createButton, loginButton }) => {
              const value = await func(...args);
              return {
                ...value,
                createButtonClickCount: createButton.clickCount,
                loginButtonClickCount: loginButton.clickCount,
              };
            });
            frameResults.push(result);
            return [{ frameId: target.frameIds?.[0] || 0, result: { ...result, status: { ...result.status, host: 'www.paypal.com' } } }];
          }
          const result = await withPayPalScaDom(async () => func(...args));
          frameResults.push(result);
          return [{ frameId: target.frameIds?.[0] || 0, result: { ...result, status: { ...result.status, host: 'www.paypal.com' } } }];
        },
      },
      tabs: {
        update: async () => ({}),
      },
    },
    completeStepFromBackground: async (step, payload) => {
      completed.push({ step, payload });
    },
    getTabId: async () => 1,
    isTabAlive: async () => true,
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executeCustomPayPayPalAssist({});

  assert.equal(frameResults.length, 2);
  assert.equal(frameResults[0].kind, 'paypal-login');
  assert.equal(frameResults[0].createButtonClickCount, 1);
  assert.equal(frameResults[0].loginButtonClickCount, 0);
  assert.equal(frameResults[0].clickedAssistButton, true);
  assert.equal(frameResults[0].clickResult.buttonText, 'Create an Account');
  assert.equal(frameResults[0].clickResult.reason, 'paypal_create_account');
  assert.equal(frameResults[1].kind, 'paypal-sca');
  assert.equal(frameResults[1].status.hasScaMultiField, true);
  assert.equal(frameResults[1].status.scaInputCount, 6);
  assert.deepEqual(completed.map((item) => item.step), [8]);
  assert.equal(completed[0].payload.plusCustomPayAssistStage, 'paypal_otp_required');
  assert.equal(frameResults[0].logs.some((message) => message.includes('已点击 PayPal 创建账户按钮：Create an Account')), true);
});

test('Custom Pay assist fills PayPal onboarding email and continues payment', async () => {
  const api = loadModule();
  const completed = [];
  const frameResults = [];

  let calls = 0;

  const executor = api.createCustomPayExecutor({
    addLog: async () => {},
    chrome: {
      scripting: {
        executeScript: async ({ target, func, args = [] }) => {
          assert.equal(target.tabId, 1);
          calls += 1;
          if (calls === 1) {
            const result = await withPayPalOnboardingDom(async ({ continueButton, emailInput }) => {
              const value = await func(...args);
              return {
                ...value,
                continueButtonClickCount: continueButton.clickCount,
                emailInputValue: emailInput.value,
              };
            });
            frameResults.push(result);
            return [{ frameId: target.frameIds?.[0] || 0, result: { ...result, status: { ...result.status, host: 'www.paypal.com' } } }];
          }
          const result = await withPayPalScaDom(async () => func(...args));
          frameResults.push(result);
          return [{ frameId: target.frameIds?.[0] || 0, result: { ...result, status: { ...result.status, host: 'www.paypal.com' } } }];
        },
      },
      tabs: {
        update: async () => ({}),
      },
    },
    completeStepFromBackground: async (step, payload) => {
      completed.push({ step, payload });
    },
    getTabId: async () => 1,
    isTabAlive: async () => true,
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executeCustomPayPayPalAssist({
    currentPayPalAccountId: 'pp-1',
    paypalAccounts: [
      { id: 'pp-1', email: 'pool@example.com', password: 'secret' },
    ],
  });

  assert.equal(frameResults.length, 2);
  assert.equal(frameResults[0].kind, 'paypal-onboarding');
  assert.equal(frameResults[0].emailInputValue, 'pool@example.com');
  assert.equal(frameResults[0].continueButtonClickCount, 1);
  assert.equal(frameResults[0].emailFilled, true);
  assert.equal(frameResults[0].clickedAssistButton, true);
  assert.equal(frameResults[0].clickResult.buttonText, '繼續付款');
  assert.equal(frameResults[1].kind, 'paypal-sca');
  assert.equal(frameResults[1].status.hasScaMultiField, true);
  assert.equal(frameResults[1].status.scaInputCount, 6);
  assert.deepEqual(completed.map((item) => item.step), [8]);
  assert.equal(completed[0].payload.plusCustomPayAssistStage, 'paypal_otp_required');
  assert.equal(frameResults[0].logs.some((message) => message.includes('已填写 PayPal onboarding 邮箱并点击继续付款：pool@example.com')), true);
});

async function withStripeHostedPaymentDom(operation) {
  const originals = new Map();
  const setGlobal = (key, value) => {
    originals.set(key, {
      exists: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
    globalThis[key] = value;
  };
  const restoreGlobals = () => {
    for (const [key, original] of originals) {
      if (original.exists) {
        globalThis[key] = original.value;
      } else {
        delete globalThis[key];
      }
    }
  };

  class FakeHTMLElement extends FakeElement {}
  class FakeHTMLInputElement extends FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  class FakeHTMLTextAreaElement extends FakeHTMLElement {}
  class FakeEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }

  const documentElement = new FakeHTMLElement('html');
  const head = new FakeHTMLElement('head');
  const body = new FakeHTMLElement('body');
  const form = new FakeHTMLElement('form');
  const paypalButton = new FakeHTMLElement('button', { 'data-testid': 'paypal-accordion-item-button', type: 'button' }, 'PayPal');
  const country = createFakeSelect(FakeHTMLSelectElement, { id: 'billingCountry', name: 'billingCountry' }, [
    { value: '', text: 'Country' },
    { value: 'US', text: 'United States' },
  ]);
  const line1Input = new FakeHTMLInputElement('input', { id: 'billingAddressLine1', name: 'billingAddressLine1', autocomplete: 'address-line1' });
  const cityInput = new FakeHTMLInputElement('input', { id: 'billingLocality', name: 'billingLocality', autocomplete: 'address-level2' });
  const postalInput = new FakeHTMLInputElement('input', { id: 'billingPostalCode', name: 'billingPostalCode', autocomplete: 'postal-code' });
  const state = createFakeSelect(FakeHTMLSelectElement, { id: 'billingAdministrativeArea', name: 'billingAdministrativeArea' }, [
    { value: '', text: 'State' },
    { value: 'NY', text: 'New York' },
  ]);
  const termsCheckbox = new FakeHTMLInputElement('input', { id: 'termsOfServiceConsentCheckbox', type: 'checkbox' });
  const submitButton = new FakeHTMLElement('button', { type: 'submit', 'data-testid': 'hosted-payment-submit-button' }, 'Subscribe');

  termsCheckbox.checked = false;
  termsCheckbox.click = () => {
    termsCheckbox.clickCount += 1;
    termsCheckbox.checked = true;
  };

  documentElement.appendChild(head);
  documentElement.appendChild(body);
  body.appendChild(form);
  [
    paypalButton,
    country,
    line1Input,
    cityInput,
    postalInput,
    state,
    termsCheckbox,
    submitButton,
  ].forEach((element) => form.appendChild(element));

  const findById = (id) => documentElement.querySelector(`#${id}`);
  const document = {
    readyState: 'complete',
    documentElement,
    head,
    body,
    activeElement: null,
    createElement: (tagName) => new FakeHTMLElement(tagName),
    getElementById: findById,
    querySelector: (selector) => documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    dispatchEvent: () => true,
  };
  body.innerText = 'Stripe checkout billing address verification code Subscribe';
  body.textContent = body.innerText;

  [line1Input, cityInput, postalInput].forEach((input) => {
    input.focus = () => { document.activeElement = input; };
    input.blur = () => { if (document.activeElement === input) document.activeElement = null; };
  });

  const storage = new Map([
    ['customPayUsAddress', JSON.stringify({
      street: '350 5th Ave',
      city: 'New York',
      state: 'New York',
      zip: '10118',
      source: 'test_cache',
      sourceText: '测试地址',
    })],
  ]);
  const location = {
    href: 'https://pay.openai.com/pay/cs_live_demo',
    host: 'pay.openai.com',
    hostname: 'pay.openai.com',
    pathname: '/pay/cs_live_demo',
  };
  const window = {
    location,
    getComputedStyle: (element) => element?.style || { display: 'block', visibility: 'visible', opacity: '1' },
  };

  setGlobal('HTMLElement', FakeHTMLElement);
  setGlobal('HTMLInputElement', FakeHTMLInputElement);
  setGlobal('HTMLSelectElement', FakeHTMLSelectElement);
  setGlobal('HTMLTextAreaElement', FakeHTMLTextAreaElement);
  setGlobal('Event', FakeEvent);
  setGlobal('MouseEvent', FakeEvent);
  setGlobal('KeyboardEvent', FakeEvent);
  setGlobal('InputEvent', FakeEvent);
  setGlobal('document', document);
  setGlobal('window', window);
  setGlobal('location', location);
  setGlobal('sessionStorage', {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => { storage.set(key, String(value)); },
  });
  setGlobal('setTimeout', (callback) => {
    callback();
    return 0;
  });

  try {
    return await operation({
      country,
      line1Input,
      cityInput,
      postalInput,
      state,
      paypalButton,
      submitButton,
      termsCheckbox,
    });
  } finally {
    restoreGlobals();
  }
}

test('Custom Pay assist waits for PayPal SCA after checkout signup submit', async () => {
  const api = loadModule();
  const completed = [];
  const logs = [];
  const frameResults = [];
  let calls = 0;

  const executor = api.createCustomPayExecutor({
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      scripting: {
        executeScript: async ({ target, func, args = [] }) => {
          assert.equal(target.tabId, 1);
          calls += 1;
          if (calls === 1) {
            const result = await withPayPalCheckoutSignupDom(async ({ submitButton }) => {
              const value = await func(...args);
              return {
                ...value,
                submitButtonClickCount: submitButton.clickCount,
              };
            });
            frameResults.push(result);
            return [{ frameId: target.frameIds?.[0] || 0, result: { ...result, status: { ...result.status, host: 'www.paypal.com' } } }];
          }
          const result = await withPayPalScaDom(async () => func(...args));
          frameResults.push(result);
          return [{ frameId: target.frameIds?.[0] || 0, result: { ...result, status: { ...result.status, host: 'www.paypal.com' } } }];
        },
      },
      tabs: {
        update: async () => ({}),
      },
    },
    completeStepFromBackground: async (step, payload) => {
      completed.push({ step, payload });
    },
    getTabId: async () => 1,
    isTabAlive: async () => true,
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executeCustomPayPayPalAssist({
    customPayAssistPhone: '15555550123',
    customPayCardNumber: '4242424242424242',
    customPayCardExpiry: '12/30',
    customPayCardCvv: '123',
  });

  assert.equal(frameResults.length, 2);
  assert.equal(frameResults[0].kind, 'paypal-checkout');
  assert.equal(frameResults[0].submitButtonClickCount, 1);
  assert.equal(frameResults[0].clickedAssistButton, true);
  assert.equal(frameResults[0].clickResult.buttonText, 'Agree & Create Account');
  assert.equal(frameResults[0].status.hasOtpInput, false);
  assert.equal(frameResults[0].status.hasScaMultiField, false);
  assert.equal(frameResults[0].status.hasConsentButton, false);
  assert.equal(frameResults[1].kind, 'paypal-sca');
  assert.equal(frameResults[1].status.hasScaMultiField, true);
  assert.equal(frameResults[1].status.scaInputCount, 6);
  assert.deepEqual(completed.map((item) => item.step), [8]);
  assert.equal(completed[0].payload.plusCustomPayAssistStage, 'paypal_otp_required');
  assert.equal(logs.some(({ message }) => message.includes('已提交 PayPal checkout signup 表单')), true);
  assert.equal(logs.some(({ message }) => message.includes('已显示 PayPal 6 位短信验证码输入框')), true);
});

test('Custom Pay assist clicks Subscribe on Stripe before waiting for PayPal verification', async () => {
  const api = loadModule();
  const completed = [];
  const logs = [];
  const frameResults = [];
  let calls = 0;

  const executor = api.createCustomPayExecutor({
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      scripting: {
        executeScript: async ({ target, func, args = [] }) => {
          assert.equal(target.tabId, 1);
          calls += 1;
          if (calls === 1) {
            const result = await withStripeHostedPaymentDom(async ({ submitButton, paypalButton, termsCheckbox }) => {
              const value = await func(...args);
              return {
                ...value,
                paypalButtonClickCount: paypalButton.clickCount,
                submitButtonClickCount: submitButton.clickCount,
                termsCheckboxClickCount: termsCheckbox.clickCount,
              };
            });
            frameResults.push(result);
            return [{ frameId: 0, result }];
          }
          return [{
            frameId: 0,
            result: {
              kind: 'complete',
              clickedAssistButton: false,
              clickResult: { clicked: false, reason: 'already_complete' },
              status: {
                url: 'https://chatgpt.com/',
                host: 'chatgpt.com',
                path: '/',
                looksComplete: false,
              },
              logs: [],
              url: 'https://chatgpt.com/',
            },
          }];
        },
      },
      tabs: {
        update: async () => ({}),
      },
    },
    completeStepFromBackground: async (step, payload) => {
      completed.push({ step, payload });
    },
    getTabId: async () => 1,
    isTabAlive: async () => true,
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executeCustomPayPayPalAssist({});

  assert.equal(frameResults.length, 1);
  assert.equal(frameResults[0].kind, 'stripe');
  assert.equal(frameResults[0].clickedAssistButton, true);
  assert.equal(frameResults[0].clickResult.buttonText, 'Subscribe');
  assert.equal(frameResults[0].submitButtonClickCount, 1);
  assert.equal(frameResults[0].paypalButtonClickCount, 2);
  assert.equal(frameResults[0].termsCheckboxClickCount, 1);
  assert.equal(frameResults[0].status.hasOtpInput, false);
  assert.equal(frameResults[0].status.otpInputCount, 0);
  assert.equal(frameResults[0].status.hasScaMultiField, false);
  assert.equal(frameResults[0].status.hasConsentButton, false);
  assert.equal(logs.some(({ message }) => message.includes('已在 Stripe/支付方式页选择 PayPal（Subscribe）')), true);
  assert.equal(logs.some(({ message }) => message.includes('已显示 PayPal 6 位短信验证码输入框')), false);
  assert.deepEqual(completed.map((item) => item.step), [8]);
  assert.equal(completed[0].payload.plusCustomPayAssistStage, 'payment_completed');
});

