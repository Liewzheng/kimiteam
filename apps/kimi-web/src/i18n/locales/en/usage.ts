export default {
  panelTitle: 'Usage',
  description: 'Subagent token usage for this session',
  runs: '{count} runs',
  byModel: 'By model',
  byMember: 'By member',
  totalTokens: '{tokens} tokens total',
  noRows: 'No rows yet',
  loading: 'Loading usage…',
  loadFailed: 'Could not load usage: {error}',
  empty: 'No usage recorded yet',
  emptyHint: 'Subagent runs will show up here as they happen.',
  openMember: 'Open {name}',
} as const;
