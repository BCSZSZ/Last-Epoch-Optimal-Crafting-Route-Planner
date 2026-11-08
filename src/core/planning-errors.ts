export class PlanningCancelledError extends Error {
  constructor() { super('规划任务已取消'); this.name = 'AbortError'; }
}
