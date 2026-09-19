(function attachMultiCCChatUserInputCard(global) {
  'use strict';

  function createController(options) {
    const opts = options || {};
    const doc = opts.document || global.document;
    const elements = opts.elements || {};
    const root = elements.root || doc?.getElementById('pending-user-input-card');
    const question = elements.question || doc?.getElementById('pending-user-input-question');
    const reason = elements.reason || doc?.getElementById('pending-user-input-reason');
    const optionsEl = elements.options || doc?.getElementById('pending-user-input-options');
    const textInput = elements.textInput || doc?.getElementById('pending-user-input-text');
    const submitButton = elements.submitButton || doc?.getElementById('pending-user-input-submit');
    const dismissButton = elements.dismissButton || doc?.getElementById('pending-user-input-dismiss');
    const dismissRequest = opts.dismissRequest;
    const showError = opts.showError || (() => {});
    const submitAnswer = opts.submitAnswer || (() => false);
    // Secret mode: the typed value goes straight to POST /api/secrets via this
    // port and never becomes chat text. Only a name-only confirmation message
    // is sent afterwards, so the value never passes through any LLM API.
    const submitSecret = opts.submitSecret || null;
    const isConnected = opts.isConnected || (() => true);
    // Collapsed-state floating bubble affordances (optional — a host that does
    // not ship the button/fab simply skips the collapse feature).
    const collapseBtn = elements.collapseBtn || doc?.getElementById('pending-user-input-collapse');
    const fab = elements.fab || doc?.getElementById('pending-user-input-fab');
    if (!doc || !root || !question || !reason || !optionsEl || !textInput || !submitButton) {
      throw new TypeError('[user-input-card] complete DOM elements are required');
    }

    let requestId = '';
    let submitting = false;
    let optionInputs = [];
    let secretName = null;    // set while the card waits for a vault entry
    let controls = [textInput, submitButton];
    let lastMessage = null;     // last rendered message, for re-expand after collapse
    let collapsed = false;      // true while the card is hidden and the fab is shown

    // chat.html 里 #pending-user-input-text 是 <textarea>：它的 .type 是只读
    // getter，严格模式下赋值直接抛 TypeError。掩码因此在 textarea 上走 CSS
    // （-webkit-text-security），只有真 <input> 宿主才切 type='password'。
    function maskTextInput(masked) {
      if (textInput.tagName === 'INPUT') { textInput.type = masked ? 'password' : 'text'; return; }
      textInput.classList.toggle('secret-mask', masked);
      textInput.dataset.masked = masked ? '1' : '';
    }

    function setAvailability() {
      const disabled = submitting || !isConnected();
      for (const control of controls) control.disabled = disabled;
      if (collapseBtn) collapseBtn.disabled = disabled;
      if (dismissButton) dismissButton.disabled = disabled || !dismissRequest;
      root.dataset.submitting = submitting ? '1' : '';
    }

    function clear(expectedRequestId) {
      if (expectedRequestId && requestId && expectedRequestId !== requestId) return false;
      requestId = '';
      submitting = false;
      optionInputs = [];
      secretName = null;
      controls = [textInput, submitButton];
      collapsed = false;
      lastMessage = null;
      root.hidden = true;
      if (fab) fab.hidden = true;
      root.dataset.requestId = '';
      question.textContent = '';
      reason.textContent = '';
      reason.hidden = true;
      optionsEl.replaceChildren();
      textInput.value = '';
      maskTextInput(false);
      if (textInput.placeholder) textInput.placeholder = '';
      setAvailability();
      return true;
    }

    function submit(answer) {
      const value = String(answer == null ? '' : answer).trim();
      if (!requestId || !value || submitting || !isConnected()) return false;
      if (secretName) return submitSecretValue(value);
      submitting = true;
      setAvailability();
      const accepted = submitAnswer(value, requestId) === true;
      if (accepted) clear(requestId);
      else {
        submitting = false;
        setAvailability();
      }
      return accepted;
    }

    // Secret flow is async: the value is persisted to the local vault first,
    // and only a successful save clears the card. A failed save keeps the card
    // (and the value in the masked field) so nothing is lost.
    async function submitSecretValue(value) {
      if (!submitSecret) return false;
      submitting = true;
      setAvailability();
      try {
        const accepted = await submitSecret(value, requestId, secretName);
        if (accepted === true) { clear(requestId); return true; }
      } catch (error) {
        showError(error);
      }
      if (requestId) { submitting = false; setAvailability(); }
      return false;
    }

    async function dismiss() {
      if (!requestId || submitting || !isConnected() || !dismissRequest) return false;
      const id = requestId;
      submitting = true;
      setAvailability();
      try {
        const result = await dismissRequest(id);
        if (!result?.ok) throw new Error(result?.code || result?.error || 'dismiss_failed');
        clear(id);
        return true;
      } catch (error) {
        showError(error);
        return false;
      } finally {
        // A different question may have arrived while HTTP was in flight.
        if (requestId === id) { submitting = false; setAvailability(); }
      }
    }

    // Collapse the card into the floating bubble so the flex row reflows and
    // the user can scroll the conversation for context. Purely local UI state:
    // the server still considers the prompt pending until an answer resolves
    // it (which fires user_input_resolved → clear → hides the bubble too).
    function collapse() {
      if (!requestId || collapsed) return false;
      collapsed = true;
      root.hidden = true;
      if (fab) fab.hidden = false;
      return true;
    }
    function expand() {
      if (!collapsed) return false;
      collapsed = false;
      if (fab) fab.hidden = true;
      // Rebuild the card from the last rendered message (option inputs included).
      if (lastMessage) render(lastMessage);
      return true;
    }

    function render(message) {
      if (!message || !message.requestId) return false;
      lastMessage = message;
      collapsed = false;
      if (fab) fab.hidden = true;
      requestId = String(message.requestId);
      const values = Array.isArray(message.options)
        ? message.options.map(value => String(value).trim()).filter(Boolean)
        : [];
      const allowMultiple = message.allowMultiple === true && values.length > 1;
      submitting = false;
      optionInputs = [];
      controls = [textInput, submitButton];
      root.dataset.requestId = requestId;
      question.textContent = String(message.question || '请补充必要信息');
      reason.textContent = String(message.reason || '');
      reason.hidden = !reason.textContent;
      optionsEl.replaceChildren();
      textInput.value = '';
      // Secret mode: masked input, value saved to the local vault (never chat).
      secretName = message.inputType === 'secret' && /^[A-Za-z0-9_.-]{1,64}$/.test(String(message.secretName || ''))
        ? String(message.secretName) : null;
      maskTextInput(secretName !== null);
      textInput.autocomplete = 'off';
      if (textInput.placeholder) {
        textInput.placeholder = secretName ? '输入敏感信息（仅保存到本地保险箱，不进入对话）' : '';
      }

      for (const value of values) {
        if (allowMultiple) {
          const label = doc.createElement('label');
          label.className = 'pending-input-option';
          const checkbox = doc.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = value;
          const labelText = doc.createElement('span');
          labelText.textContent = value;
          label.append(checkbox, labelText);
          optionsEl.appendChild(label);
          optionInputs.push(checkbox);
          controls.push(checkbox);
        } else {
          const button = doc.createElement('button');
          button.type = 'button';
          button.className = 'pending-input-option';
          button.textContent = value;
          button.addEventListener('click', () => submit(value));
          optionsEl.appendChild(button);
          controls.push(button);
        }
      }
      root.hidden = false;
      setAvailability();
      return true;
    }

    submitButton.addEventListener('click', () => {
      const selected = optionInputs.filter(input => input.checked).map(input => input.value);
      const custom = String(textInput.value || '').trim();
      if (custom) selected.push(custom);
      submit(selected.join(', ') || custom);
    });
    textInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submitButton.click();
      }
    });
    if (dismissButton) dismissButton.addEventListener('click', dismiss);
    if (collapseBtn) collapseBtn.addEventListener('click', collapse);
    if (fab) fab.addEventListener('click', expand);

    return Object.freeze({
      clear,
      collapse,
      expand,
      render,
      setConnected: setAvailability,
      submit,
      dismiss,
    });
  }

  const api = Object.freeze({ createController });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatUserInputCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
