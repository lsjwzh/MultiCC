(function attachMultiCCChatSecretSubmit(global) {
  'use strict';

  // 聊天「安全输入框」的提交端口（chat-user-input-card.js 的 secret 模式）：
  // 用户填写的值直存本地保险箱（POST /api/secrets），成功后只把「已保存」
  // 的确认文案作为聊天消息发出——密钥明文不进入对话、不经过任何 LLM API。
  // 独立文件：chat.js 是 3000 行预算棘轮文件，只减不增。
  function create({ chatApi, withToken, addSystemMsg, setInput, send, sessionId }) {
    return async function submitSecret(value, requestId, secretName) {
      let result = null;
      try {
        result = await chatApi.json(withToken('/api/secrets'), {
          method: 'POST',
          json: { name: secretName, value, sessionId: sessionId(), source: 'user' },
        });
      } catch (error) {
        addSystemMsg('保存失败：' + chatApi.errorText(error));
        return false;
      }
      if (!result || result.ok !== true) {
        addSystemMsg('保存失败：' + chatApi.errorText(result));
        return false;
      }
      setInput(`（敏感信息 ${secretName} 已通过安全弹窗填写并保存到本地保险箱，值不会出现在对话里）`);
      return send() === true;
    };
  }

  const api = Object.freeze({ create });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatSecretSubmit = api;
})(typeof window !== 'undefined' ? window : globalThis);
