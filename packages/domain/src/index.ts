export type EntityId = string;
export type ISODateTime = string;

export interface PersonalSpace {
  id: EntityId;
  name: string;
}

export interface Goal {
  id: EntityId;
  spaceId: EntityId;
  title: string;
  status: 'active' | 'completed' | 'archived';
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Project {
  id: EntityId;
  spaceId: EntityId;
  goalId?: EntityId;
  title: string;
  status: 'active' | 'completed' | 'archived';
  version: number;
}

export interface Task {
  id: EntityId;
  spaceId: EntityId;
  projectId?: EntityId;
  title: string;
  status: 'open' | 'done' | 'archived';
  version: number;
}

export interface CommandReceipt<TResult = unknown> {
  commandId: string;
  status: 'applied' | 'rejected' | 'duplicate';
  result?: TResult;
  appliedAt?: ISODateTime;
  reason?: string;
}
