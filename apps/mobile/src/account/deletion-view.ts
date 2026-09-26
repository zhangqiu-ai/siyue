import type {AccountDeletionFlowState} from '@siyue/adapters';
import {fill,type DeletionText} from './deletion-messages.ts';
import {recipientSelectable,type DeletionRecipient,type DeletionRecipientRead} from './deletion-recipients.ts';

/** Pure view models for the mobile deletion screens. Nothing here reads a client, a clock or native
 *  storage, so the wording, the empty/blocked states and the no-default rule can be checked directly. */
export type DeletionFlowState=AccountDeletionFlowState;
export type DeletionFamilyView=DeletionFlowState['families'][number];
export type DeletionFamilyDisposition=NonNullable<DeletionFamilyView['choice']>;

export interface DeletionRow {
  readonly key:string;readonly title:string;readonly detail:string;readonly tone:'default'|'muted'|'error';
}
export interface DeletionChoiceOption {readonly kind:'transfer'|'end-family-access';readonly label:string;readonly detail:string;}
export interface DeletionFamilyRow {
  readonly familyId:string;readonly title:string;readonly detail:string;readonly role:string;
  readonly choice:DeletionFamilyDisposition|null;readonly choiceDetail:string|null;
  readonly options:readonly DeletionChoiceOption[];
}
export interface DeletionFamilySection {
  readonly rows:readonly DeletionRow[];readonly families:readonly DeletionFamilyRow[];readonly childDeviceCount:number;
}
export interface DeletionRecipientRow {readonly subjectId:string;readonly title:string;readonly detail:string;readonly selectable:boolean;}
export interface DeletionRecipientSection {readonly status:'ready'|'empty'|'unavailable';readonly rows:readonly DeletionRecipientRow[];}
export interface DeletionProgressSection {readonly rows:readonly DeletionRow[];readonly completed:boolean;readonly receiptMissing:boolean;}

/** The pre-check page lists what a deletion touches before any impact is read. It carries no count, so
 *  it cannot show a number this device has not been told. */
export function introRows(text:DeletionText):readonly DeletionRow[] {
  return [
    {key:'account',title:text.rowAccount,detail:text.rowAccountDetail,tone:'default'},
    {key:'family',title:text.rowFamily,detail:text.rowFamilyDetail,tone:'default'},
    {key:'local',title:text.rowLocal,detail:text.rowLocalDetail,tone:'default'},
  ];
}

/** The role the caller holds here. A family reached only through guardianship has no membership role. */
export function familyRoleLabel(family:DeletionFamilyView,text:DeletionText):string {
  if(family.role==='owner')return family.soleActiveOwner?text.familyRoleOwnerSole:text.familyRoleOwner;
  if(family.role==='admin')return text.familyRoleAdmin;
  if(family.role==='member')return text.familyRoleMember;
  return text.familyRoleGuardian;
}

/** The real impact of one family: its other adults, its children and the child devices that a
 *  handover or a end-of-access decision would revoke. */
export function familyDetail(family:DeletionFamilyView,text:DeletionText):string {
  const parts=[familyRoleLabel(family,text)];
  if(family.otherActiveAdultCount>0)parts.push(fill(text.familyOtherAdults,{count:family.otherActiveAdultCount}));
  if(family.otherActiveChildCount>0)parts.push(fill(text.familyOtherChildren,{count:family.otherActiveChildCount}));
  const devices=childDeviceCountOf([family]);
  if(devices>0)parts.push(fill(text.familyDevices,{count:devices}));
  else if(family.guardianships.length>0)parts.push(fill(text.familyGuardianship,{children:family.guardianships.length}));
  return parts.join(' · ');
}

/** Child devices are counted per child, so a child that appears under two guardianships is not counted
 *  twice and a revoke is never presented as affecting more devices than exist. */
function childDeviceCountOf(families:readonly DeletionFamilyView[]):number {
  const perChild=new Map<string,number>();
  for(const family of families)for(const guardianship of family.guardianships) {
    const known=perChild.get(guardianship.childSubjectId)??0;
    perChild.set(guardianship.childSubjectId,Math.max(known,guardianship.activeChildDeviceCount));
  }
  let total=0;for(const count of perChild.values())total+=count;return total;
}

/** Both decisions are offered for every family; the owner branch ends management and freezes the
 *  family, a non-owner branch ends this adult's own access instead. Neither is preselected. */
export function familyChoiceOptions(family:DeletionFamilyView,text:DeletionText):readonly DeletionChoiceOption[] {
  const owner=family.role==='owner';
  return [
    {kind:'transfer' as const,label:text.choiceTransfer,detail:text.choiceTransferDetail},
    {kind:'end-family-access' as const,label:owner?text.choiceEndOwner:text.choiceEndMember,
      detail:owner?text.choiceEndOwnerDetail:text.choiceEndMemberDetail},
  ];
}

/** The settled choice as the caller will see it again on the confirmation page. A handover names the
 *  recipient and whether that recipient's acceptance is current; an unnamed handover stays unnamed. */
export function choiceSummary(family:DeletionFamilyView,text:DeletionText,names:Readonly<Record<string,string>>={}):string|null {
  const choice=family.choice;
  if(choice===null)return null;
  if(choice.kind==='end-family-access')return family.role==='owner'?text.chosenEndOwner:text.chosenEndMember;
  const name=names[family.familyId];
  if(!name)return text.chosenTransferUnnamed;
  return fill(text.chosenTransfer,{name,status:text.confirmAccepted});
}

/** One row per affected family, then one row for the child devices the request will revoke. */
export function familySection(state:DeletionFlowState,text:DeletionText,names:Readonly<Record<string,string>>={}):DeletionFamilySection {
  const families=state.families.map((family,index)=>({familyId:family.familyId,
    title:fill(text.familyLabel,{index:index+1}),detail:familyDetail(family,text),
    role:familyRoleLabel(family,text),choice:family.choice,choiceDetail:choiceSummary(family,text,names),
    options:familyChoiceOptions(family,text)}));
  const childDeviceCount=childDeviceCountOf(state.families);
  const rows:DeletionRow[]=[...families.map(family=>({key:family.familyId,title:family.title,
    detail:family.choiceDetail??family.detail,tone:'default' as const}))];
  rows.push({key:'devices',title:text.deviceRow,
    detail:childDeviceCount>0?text.deviceRowPending:text.deviceRowNone,tone:'default'});
  return {rows,families,childDeviceCount};
}

/** The recipient page: every candidate with its membership and acceptance state. A candidate that is
 *  no longer an active adult, or has not accepted, is shown but cannot be chosen. */
export function recipientSection(read:DeletionRecipientRead|null,text:DeletionText):DeletionRecipientSection {
  if(!read)return {status:'empty',rows:[]};
  if(read.kind==='unavailable')return {status:'unavailable',rows:[]};
  if(read.recipients.length===0)return {status:'empty',rows:[]};
  const rows=read.recipients.map(recipient=>({subjectId:recipient.subjectId,title:recipient.label,
    detail:recipientDetail(recipient,text),selectable:recipientSelectable(recipient)}));
  return {status:'ready',rows};
}

function recipientDetail(recipient:DeletionRecipient,text:DeletionText):string {
  const parts=[recipient.membership==='active'?text.recipientActive:text.recipientInactive,
    recipient.management==='accepted'?text.recipientAccepted:text.recipientPending] as string[];
  parts.push(recipient.guardianship==='accepted'?text.recipientGuardianshipAccepted:
    recipient.guardianship==='pending'?text.recipientGuardianshipPending:text.recipientGuardianshipNone);
  return parts.join(' · ');
}

/** A handover is submittable only while every chosen recipient is still an active adult whose
 *  acceptance is current; the choice made earlier cannot become a silent default. */
export function choicesSettled(state:DeletionFlowState,recipients:Readonly<Record<string,DeletionRecipient|undefined>>):boolean {
  if(state.step!=='families'||state.families.length===0)return false;
  return state.families.every(family=>{
    const choice=family.choice;
    if(choice===null)return false;
    if(choice.kind==='end-family-access')return true;
    const recipient=recipients[family.familyId];
    return recipient!==undefined&&recipient.subjectId===choice.recipientSubjectId&&recipientSelectable(recipient);
  });
}

/** The confirmation page repeats every settled choice and the verification the caller still owes. */
export function confirmRows(state:DeletionFlowState,text:DeletionText,names:Readonly<Record<string,string>>={}):readonly DeletionRow[] {
  const rows:DeletionRow[]=state.families.length===0
    ?[{key:'none',title:text.rowFamily,detail:text.confirmNone,tone:'default'}]
    :state.families.map((family,index)=>({key:family.familyId,title:fill(text.familyLabel,{index:index+1}),
      detail:choiceSummary(family,text,names)??text.confirmNone,tone:'default'}));
  rows.push({key:'reauth',title:text.confirmReauth,detail:text.confirmReauthDetail,tone:'default'});
  return rows;
}

/** Progress reports the two dimensions the receipt actually carries, apart, and never turns a missing
 *  or unusable receipt into completion. */
export function progressSection(state:DeletionFlowState,text:DeletionText):DeletionProgressSection {
  const status=state.status;
  if(!status)return {rows:[],completed:false,receiptMissing:!state.busy};
  return {
    completed:state.completed,
    receiptMissing:false,
    rows:[
      {key:'server',title:text.progressServer,
        detail:status.serverDataDeleted?text.progressServerDeleted:text.progressServerPending,tone:'default'},
      {key:'provider',title:text.progressProvider,
        detail:status.providerRevocationPending?text.progressProviderPending:text.progressProviderDone,tone:'default'},
      {key:'outcome',title:text.progressOutcome,
        detail:state.completed?text.progressOutcomeComplete:text.progressOutcomePending,
        tone:state.completed?'default':'muted'},
    ],
  };
}

/** The exit control's wording follows the step: the pre-check is cancelled, a settled request is
 *  closed, and every step in between goes back instead of leaving the flow. */
export function exitLabel(step:DeletionFlowState['step'],text:DeletionText):string {
  return step==='progress'?text.close:text.cancel;
}

/** Back is available on every step except an in-flight submission, and it never leaves a locked
 *  request: a locked flow has no back control at all until the original request is retried. */
export function backAllowed(state:DeletionFlowState):boolean {
  return !state.locked&&!state.busy&&state.step!=='submitting';
}
