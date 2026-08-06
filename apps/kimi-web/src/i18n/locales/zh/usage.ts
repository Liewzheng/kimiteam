export default {
  panelTitle: '用量',
  description: '当前会话的子代理 token 用量',
  runs: '{count} 次运行',
  byModel: '按模型',
  byMember: '按成员',
  totalTokens: '共 {tokens} tokens',
  noRows: '暂无数据',
  loading: '加载用量…',
  loadFailed: '无法加载用量：{error}',
  empty: '暂无用量记录',
  emptyHint: '子代理运行后这里会显示用量。',
} as const;
