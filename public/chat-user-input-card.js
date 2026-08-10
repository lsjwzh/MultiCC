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
    const submitAnswer = opts.submitAnswer || (() => false);
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
    let controls = [textInput, submitButton];
    let lastMessage = null;     // last rendered message, for re-expand after collapse
    let collapsed = false;      // true while the card is hidden and the fab is shown

    function setAvailability() {
      const disabled = submitting || !isConnected();
      for (const control of controls) control.disabled = disabled;
      if (collapseBtn) collapseBtn.disabled = disabled;
      root.dataset.submitting = submitting ? '1' : '';
    }

    function clear(expectedRequestId) {
      if (expectedRequestId && requestId && expectedRequestId !== requestId) return false;
      requestId = '';
      submitting = false;
      optionInputs = [];
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
      setAvailability();
      return true;
    }

    function submit(answer) {
      const value = String(answer == null ? '' : answer).trim();
      if (!requestId || !value || submitting || !isConnected()) return false;
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
    if (collapseBtn) collapseBtn.addEventListener('click', collapse);
    if (fab) fab.addEventListener('click', expand);

    return Object.freeze({
      clear,
      collapse,
      expand,
      render,
      setConnected: setAvailability,
      submit,
    });
  }

  const api = Object.freeze({ createController });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatUserInputCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
