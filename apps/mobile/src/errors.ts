export function describeError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  const messages: Record<string, string> = {
    conflict: '记录已有变化，请刷新后重新检查。你的输入仍然保留。',
    version_conflict: '记录已有变化，请刷新后重新检查。你的输入仍然保留。',
    forbidden: '当前没有执行权限，未授权的操作无法保存。',
    expired: '草稿或审批已过期，请重新生成并确认。',
    approval_expired: '草稿或审批已过期，请重新生成并确认。',
    approval_invalid: '审批已失效，请刷新草稿并重新确认。',
    invalid_input: '内容格式不符合要求。请检查标题、项目与任务数量后重试。',
    invalid_state: '记录状态已变化，当前操作不可执行。请刷新后检查。',
    corrupt_data: '本地数据未通过完整性检查，原始数据已保留。请停止写入并联系维护者恢复。',
    unsupported_schema: '此版本无法读取本地数据格式。原始数据已保留，请使用兼容版本打开。',
    cancelled: '生成已取消，输入仍然保留。',
    unsupported: '当前运行环境或模型不支持此操作。若本地记录尚未加载，请在思玥应用中打开；模型不可用时可手动创建。',
    budget_exceeded: '模型预算已用尽，请使用手动创建。',
  };
  if (error instanceof Error && error.name === 'AbortError') return '生成已取消，输入仍然保留。';
  return Object.prototype.hasOwnProperty.call(messages, code) ? messages[code]! : '操作未能确认完成。请刷新本地记录后重试，输入仍然保留。';
}
