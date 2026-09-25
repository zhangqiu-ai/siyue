import {useRef,useState,type Dispatch,type SetStateAction,type RefObject} from 'react';
import {scopeKey,useWorkspace} from './workspace-provider';
import {ensureWorkspaceBuffer,readWorkspaceBuffer,writeWorkspaceBuffer} from './workspace-pending';
export function useWorkspaceValue<T>(name:string,initial:T):[T,Dispatch<SetStateAction<T>>]{
 const {state}=useWorkspace();const [key]=useState(()=>`${scopeKey(state)}:${name}`);
 const [value,setStateValue]=useState<T>(()=>readWorkspaceBuffer(key,initial));
 const current=useRef(value);
 const setValue:Dispatch<SetStateAction<T>>=next=>{
  const value=typeof next==='function'?(next as (current:T)=>T)(current.current):next;
  current.current=value;writeWorkspaceBuffer(key,name,value);setStateValue(value);
 };
 return [value,setValue];
}
export function useWorkspaceRef<T>(name:string,initial:T):RefObject<T>{
 const {state}=useWorkspace(),key=`${scopeKey(state)}:ref:${name}`;
 const ref=useRef<T>(initial);
 const [saved]=useState(()=>ensureWorkspaceBuffer(key,`ref:${name}`,ref));return saved;
}
