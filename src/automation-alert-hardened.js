const original = require('./automation-alert');

function sanitizeMarkdownText(value, options) {
  return original.sanitizeText(value, options)
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .replace(/@/g, '@\u200b')
    .replace(/`/g, '\\`')
    .replace(/\[([^\]]*)\]\((?:javascript|data):[^)]*\)/gi, '$1 [link removed]');
}

function hardenContext(context = {}) {
  return {
    ...context,
    summary: sanitizeMarkdownText(context.summary || ''),
    protocolBreaking: Array.isArray(context.protocolBreaking)
      ? context.protocolBreaking.map(item => sanitizeMarkdownText(item))
      : []
  };
}

module.exports = {
  ...original,
  buildFailureBody: context => original.buildFailureBody(hardenContext(context)),
  buildFailureComment: context => original.buildFailureComment(hardenContext(context)),
  sanitizeMarkdownText
};
