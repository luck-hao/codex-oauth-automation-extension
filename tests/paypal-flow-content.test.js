const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/paypal-flow.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      parenDepth += 1;
    } else if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (char === '{' && signatureEnded) {
      braceStart = index;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function createElement({
  tag = 'div',
  type = '',
  id = '',
  name = '',
  text = '',
  value = '',
  placeholder = '',
  href = '',
  attrs = {},
  style = {},
  rect = { width: 160, height: 40 },
  parentElement = null,
} = {}) {
  return {
    nodeType: 1,
    tag,
    type,
    id,
    name,
    href,
    textContent: text,
    value,
    placeholder,
    disabled: false,
    hidden: Boolean(attrs.hidden),
    attrs,
    style: {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      ...style,
    },
    parentElement,
    getAttribute(key) {
      if (key === 'type') return type;
      if (key === 'id') return id;
      if (key === 'name') return name;
      if (key === 'placeholder') return placeholder;
      if (key === 'value') return value;
      if (key === 'href') return href;
      return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
    },
    getBoundingClientRect() {
      return rect;
    },
  };
}

function loadApi(elements, locationOverrides = {}) {
  const document = {
    body: { innerText: '' },
    documentElement: {},
    querySelectorAll(selector) {
      if (selector === 'input') {
        return elements.filter((el) => el.tag === 'input');
      }
      if (selector === 'input[type="email"]') {
        return elements.filter((el) => el.tag === 'input' && el.type === 'email');
      }
      if (selector === 'input[type="password"]') {
        return elements.filter((el) => el.tag === 'input' && el.type === 'password');
      }
      if (selector === 'a, [role="link"], [href]') {
        return elements.filter((el) => el.tag === 'a' || el.attrs?.role === 'link' || el.href);
      }
      if (selector === '[data-atomic-wait-viewname="profile"]') {
        return elements.filter((el) => el.attrs?.['data-atomic-wait-viewname'] === 'profile');
      }
      if (selector.includes('button') || selector.includes('[role="button"]')) {
        return elements.filter((el) => el.tag === 'button' || el.attrs?.role === 'button');
      }
      return [];
    },
  };
  const location = {
    href: 'https://www.paypal.com/signin',
    pathname: '/signin',
    search: '',
    ...locationOverrides,
  };
  const window = {
    getComputedStyle(el) {
      return el?.style || { display: 'block', visibility: 'visible', opacity: '1' };
    },
  };

  return new Function('document', 'window', 'location', `
${extractFunction('isVisibleElement')}
${extractFunction('normalizeText')}
${extractFunction('getActionText')}
${extractFunction('getVisibleControls')}
${extractFunction('isEnabledControl')}
${extractFunction('findClickableByText')}
${extractFunction('findInputByPatterns')}
${extractFunction('findEmailInput')}
${extractFunction('findPasswordInput')}
${extractFunction('findLoginNextButton')}
${extractFunction('findEmailNextButton')}
${extractFunction('findPasswordLoginButton')}
${extractFunction('findApproveButton')}
${extractFunction('getPayPalHref')}
${extractFunction('findPayPalProfileLink')}
${extractFunction('isPayPalProfilePage')}
${extractFunction('findPayPalLogoutButton')}
${extractFunction('findPasskeyPromptButtons')}
${extractFunction('hasPasskeyPrompt')}
${extractFunction('getPayPalLoginPhase')}
${extractFunction('inspectPayPalState')}
return {
  findEmailInput,
  findPasswordInput,
  findEmailNextButton,
  findPasswordLoginButton,
  getPayPalHref,
  findPayPalProfileLink,
  isPayPalProfilePage,
  findPayPalLogoutButton,
  getPayPalLoginPhase,
  inspectPayPalState,
};
`)(document, window, location);
}

function createSubmitApi(overrides = {}) {
  const bindings = {
    waitForDocumentComplete: async () => {},
    normalizeText: (text = '') => String(text || '').replace(/\s+/g, ' ').trim(),
    findPasswordInput: () => null,
    findEmailInput: () => null,
    findEmailNextButton: () => null,
    isEnabledControl: () => true,
    findPasswordLoginButton: () => null,
    fillInput: () => {},
    simulateClick: () => {},
    waitUntil: async (predicate) => predicate(),
    findLoginNextButton: () => null,
    sleep: async () => {},
    ...overrides,
  };

  return new Function(
    'waitForDocumentComplete',
    'normalizeText',
    'findPasswordInput',
    'findEmailInput',
    'findEmailNextButton',
    'isEnabledControl',
    'findPasswordLoginButton',
    'fillInput',
    'simulateClick',
    'waitUntil',
    'findLoginNextButton',
    'sleep',
    `
${extractFunction('refillPayPalEmailInput')}
${extractFunction('submitPayPalLogin')}
return { refillPayPalEmailInput, submitPayPalLogin };
`
  )(
    bindings.waitForDocumentComplete,
    bindings.normalizeText,
    bindings.findPasswordInput,
    bindings.findEmailInput,
    bindings.findEmailNextButton,
    bindings.isEnabledControl,
    bindings.findPasswordLoginButton,
    bindings.fillInput,
    bindings.simulateClick,
    bindings.waitUntil,
    bindings.findLoginNextButton,
    bindings.sleep
  );
}

test('PayPal email page ignores hidden pre-rendered password input', () => {
  const hiddenPanel = createElement({ attrs: { 'aria-hidden': 'true' } });
  const emailInput = createElement({
    tag: 'input',
    type: 'text',
    id: 'login_email',
    name: 'login_email',
    value: 'user@example.com',
    placeholder: 'Email',
  });
  const hiddenPasswordInput = createElement({
    tag: 'input',
    type: 'password',
    id: 'login_password',
    name: 'login_password',
    parentElement: hiddenPanel,
  });
  const nextButton = createElement({
    tag: 'button',
    id: 'btnNext',
    text: 'Next',
  });

  const api = loadApi([emailInput, hiddenPasswordInput, nextButton]);

  assert.equal(api.findEmailInput(), emailInput);
  assert.equal(api.findPasswordInput(), null);
  assert.equal(api.findEmailNextButton(), nextButton);
  assert.equal(api.findPasswordLoginButton(), null);
  assert.equal(api.getPayPalLoginPhase(emailInput, api.findPasswordInput()), 'email');
});

test('PayPal combined login page still sees visible password input', () => {
  const emailInput = createElement({
    tag: 'input',
    type: 'text',
    id: 'login_email',
    name: 'login_email',
  });
  const passwordInput = createElement({
    tag: 'input',
    type: 'password',
    id: 'login_password',
    name: 'login_password',
  });
  const loginButton = createElement({
    tag: 'button',
    id: 'btnLogin',
    text: 'Log In',
  });

  const api = loadApi([emailInput, passwordInput, loginButton]);

  assert.equal(api.findEmailInput(), emailInput);
  assert.equal(api.findPasswordInput(), passwordInput);
  assert.equal(api.findPasswordLoginButton(), loginButton);
  assert.equal(api.getPayPalLoginPhase(emailInput, passwordInput), 'login_combined');
});

test('PayPal email submit refills a prefilled email before clicking next', async () => {
  const emailInput = createElement({
    tag: 'input',
    type: 'text',
    id: 'login_email',
    name: 'login_email',
    value: 'user@example.com',
    placeholder: 'Email',
  });
  const nextButton = createElement({
    tag: 'button',
    id: 'btnNext',
    text: 'Next',
  });
  const fillValues = [];
  const clicked = [];
  let focusCount = 0;
  let blurCount = 0;

  emailInput.focus = () => {
    focusCount += 1;
  };
  emailInput.blur = () => {
    blurCount += 1;
  };

  const api = createSubmitApi({
    findEmailInput: () => emailInput,
    findEmailNextButton: () => nextButton,
    fillInput: (element, value) => {
      fillValues.push(value);
      element.value = value;
    },
    simulateClick: (element) => {
      clicked.push(element);
    },
  });

  const result = await api.submitPayPalLogin({
    email: 'user@example.com',
    password: 'secret',
  });

  assert.deepEqual(fillValues, ['', 'user@example.com']);
  assert.equal(focusCount, 1);
  assert.equal(blurCount, 1);
  assert.deepEqual(clicked, [nextButton]);
  assert.deepEqual(result, {
    submitted: false,
    phase: 'email_submitted',
    awaiting: 'password_page',
  });
});

test('PayPal logged-in restriction page exposes profile link state', () => {
  const profileLink = createElement({
    tag: 'a',
    text: 'Profile',
    href: '/pay/profile?ssrt=1779185692246&token=BA-demo&ul=1&errorCode=demo',
  });

  const api = loadApi([profileLink], {
    href: 'https://www.paypal.com/checkoutnow/error?token=BA-demo',
    pathname: '/checkoutnow/error',
    search: '?token=BA-demo',
  });
  const state = api.inspectPayPalState();

  assert.equal(api.findPayPalProfileLink(), profileLink);
  assert.equal(state.profileReady, true);
  assert.equal(state.profileLinkHref, '/pay/profile?ssrt=1779185692246&token=BA-demo&ul=1&errorCode=demo');
  assert.equal(state.isProfilePage, false);
  assert.equal(state.logoutReady, false);
  assert.equal(state.needsLogin, false);
});

test('PayPal profile page exposes logout button state', () => {
  const logoutButton = createElement({
    tag: 'button',
    text: '退出登录',
    attrs: {
      'data-atomic-wait-domain': 'xo',
      'data-atomic-wait-intent': 'Logout',
      'data-atomic-wait-task': 'select_logout',
      'data-atomic-wait-viewname': 'profile',
    },
  });

  const api = loadApi([logoutButton], {
    href: 'https://www.paypal.com/pay/profile?token=BA-demo',
    pathname: '/pay/profile',
    search: '?token=BA-demo',
  });
  const state = api.inspectPayPalState();

  assert.equal(api.isPayPalProfilePage(), true);
  assert.equal(api.findPayPalLogoutButton(), logoutButton);
  assert.equal(state.profileReady, false);
  assert.equal(state.isProfilePage, true);
  assert.equal(state.logoutReady, true);
  assert.equal(state.logoutButtonText, '退出登录');
});

