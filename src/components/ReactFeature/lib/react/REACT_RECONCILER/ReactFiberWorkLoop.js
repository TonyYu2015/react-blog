import {
  SyncLane,
  NoLanes,
  markRootFinished,
  mergeLanes,
  markRootUpdated,
  NoLanePriority,
  SyncBatchedLane,
  markStarvedLanesAsExpired,
  getNextLanes,
  returnNextLanesPriority,
  includesSomeLane,
  SyncLanePriority,
  SyncBatchedLanePriority
} from './ReactFiberLane';

import {
  beginWork
} from './ReactFiberBeginWork';

import {
  runWithPriority,
  getCurrentPriorityLevel,
  ImmediatePriority as ImmediateSchedulerPriority,
  NormalPriority as NormalSchedulerPriority,
  NoPriority as NoSchedulerPriority,
  scheduleCallback,
  flushSyncCallbackQueue,
  cancelCallback,
  scheduleSyncCallback,
  now
} from './SchedulerWithReactIntegration';
import { BeforeMutationMask, Callback, Deletion, Incomplete, LayoutMask, MutationMask, NoFlags, Passive, PassiveMask, PerformedWork, Placement, PlacementAndUpdate, Snapshot, Update } from './ReactFiberFlags';
import {
  commitBeforeMutationLifeCycles as commitBeforeMutationEffectOnFiber, 
  commitPlacement, 
  commitWork,
  commitLifeCycles as commitLayoutEffectOnFiber,
  recursivelyCommitLayoutEffects,
  commitPassiveUnmount as commitPassiveUnmountOnFiber,
  commitPassiveMount as commitPassiveMountOnFiber,
} from './ReactFiberCommitWork';
import {
  completeWork
} from './ReactFiberCompleteWork';
import { cancelTimeout, noTimeout, resetAfterCommit } from '../DOM/ReactDOMHostConfig';
import { createWorkInProgress } from './ReactFiber';
import ReactCurrentOwner from '../REACT/ReactCurrentOwner';
import { 
  decoupleUpdatePriorityFromScheduler,
  deferRenderPhaseUpdateToNextBatch
 } from '../shared/ReactFeatureFlags';
import { HostRoot } from './ReactWorkTags';
import { unwindInterruptedWork } from './ReactFiberUnwindWork';
import { turn2 } from '../../tools';
let rootDoseHavePassiveEffects = false;

export const NoContext = /*             */ 0b0000000;
const BatchedContext = /*               */ 0b0000001;
const EventContext = /*                 */ 0b0000010;
const DiscreteEventContext = /*         */ 0b0000100;
const LegacyUnbatchedContext = /*       */ 0b0001000;
const RenderContext = /*                */ 0b0010000;
const CommitContext = /*                */ 0b0100000;

const RootIncomplete = 0;
const RootFatalErrored = 1;
const RootErrored = 2;
const RootSuspended = 3;
const RootSuspendedWithDelay = 4;
const RootCompleted = 5;

// Describes where we are in the React execution stack
let executionContext = NoContext;
// The root we're working on
let workInProgressRoot = null;
// The fiber we're working on
let workInProgress = null;
// The lanes we're rendering
let workInProgressRootRenderLanes = NoLanes;

// Stack that allows components to change the render lanes for its subtree
// This is a superset of the lanes we started working on at the root. The only
// case where it's different from `workInProgressRootRenderLanes` is when we
// enter a subtree that is hidden and needs to be unhidden: Suspense and
// Offscreen component.
//
// Most things in the work loop should deal with workInProgressRootRenderLanes.
// Most things in begin/complete phases should deal with subtreeRenderLanes.
export let subtreeRenderLanes = NoLanes;
// const subtreeRenderLanesCursor: StackCursor<Lanes> = createCursor(NoLanes);

// Whether to root completed, errored, suspended, etc.
let workInProgressRootExitStatus = RootIncomplete;
// A fatal error, if one is thrown
let workInProgressRootFatalError = null;
// "Included" lanes refer to lanes that were worked on during this render. It's
// slightly different than `renderLanes` because `renderLanes` can change as you
// enter and exit an Offscreen tree. This value is the combination of all render
// lanes for the entire render phase.
let workInProgressRootIncludedLanes = NoLanes;
// The work left over by components that were visited during this render. Only
// includes unprocessed updates, not work in bailed out children.
let workInProgressRootSkippedLanes = NoLanes;
// Lanes that were updated (in an interleaved event) during this render.
let workInProgressRootUpdatedLanes = NoLanes;
// Lanes that were pinged (in an interleaved event) during this render.
let workInProgressRootPingedLanes = NoLanes;

let mostRecentlyUpdatedRoot = null;

// The most recent time we committed a fallback. This lets us ensure a train
// model where we don't commit new loading states in too quick succession.
let globalMostRecentFallbackTime = 0;
const FALLBACK_THROTTLE_MS = 500;

// The absolute time for when we should start giving up on rendering
// more and prefer CPU suspense heuristics instead.
let workInProgressRootRenderTargetTime = Infinity;
// How long a render is supposed to take before we start following CPU
// suspense heuristics and opt out of rendering more content.
const RENDER_TIMEOUT_MS = 500;

// Used to avoid traversing the return path to find the nearest Profiler ancestor during commit.
let nearestProfilerOnStack = null;

let rootDoesHavePassiveEffects = false;
let rootWithPendingPassiveEffects = null;
let pendingPassiveEffectsRenderPriority = NoSchedulerPriority;
let pendingPassiveEffectsLanes = NoLanes;

// Use these to prevent an infinite loop of nested updates
const NESTED_UPDATE_LIMIT = 50;
let nestedUpdateCount = 0;
let rootWithNestedUpdates = null;

const NESTED_PASSIVE_UPDATE_LIMIT = 50;
let nestedPassiveUpdateCount = 0;

function unbatchedUpdates(fn) {
  const prevExecutionContext = executionContext;
  executionContext &= ~BatchedContext;
  executionContext |= LegacyUnbatchedContext;
  try{
    return fn();
  } finally {
    executionContext = prevExecutionContext;
    if(executionContext === NoContext) {

    }
  }
}

function requestEventTime() {
  return new Date().getTime();
}

function requestUpdateLane() {
  return SyncLane;
}

// 找出所有受到本次更新影响的节点
function markUpdateLaneFromFiberToRoot(sourceFiber, lane) {
  sourceFiber.lanes = mergeLanes(sourceFiber.lanes, lane);
  let alternate = sourceFiber.alternate;
  if(alternate !== null) {
    alternate.lanes = mergeLanes(alternate.lanes, lane);
  }

  let node = sourceFiber;
  let parent = sourceFiber.return;
  while(parent !== null) {
    parent.childLanes = mergeLanes(parent.childLanes, lane);
    alternate = parent.alternate;
    if(alternate !== null) {
      alternate.childLanes = mergeLanes(alternate.childLanes, lane);
    }

    node = parent;
    parent = parent.return;
  }

  if(node.tag === HostRoot) {
    const root = node.stateNode;
    return root;
  } else {
    return null;
  }
}

function completeUnitWork(unitOfWork) {
  let completedWork = unitOfWork;
  do{
    const current = completedWork.alternate;
    const returnFiber = completedWork.return;
    if((completedWork.flags & Incomplete) === NoFlags) {
      let next = completeWork(current, completedWork, subtreeRenderLanes);
      if(next !== null) {
        workInProgress = null;
        return;
      }
    } else {

    }

    const siblingFiber = completedWork.sibling;
    if(siblingFiber !== null) {
      workInProgress = siblingFiber;
      return;
    } 
    completedWork = returnFiber;
    workInProgress = completedWork;

  } while(completedWork !== null);
}

function performUnitOfWork(unitOfWork) {
  const current = unitOfWork.alternate;

  let next = beginWork(current, unitOfWork, subtreeRenderLanes);

  unitOfWork.memoizedProps = unitOfWork.pendingProps;

  if(next === null) {
    completeUnitWork(unitOfWork);
  } else {
    workInProgress = next;
  }
  ReactCurrentOwner.current = null;

}

function workLoopSync() {
  // 深度优先遍历fiber树，直至返回到最顶层
  while(workInProgress !== null) {
    performUnitOfWork(workInProgress);
  }
}

// 重制以及创建新的当前过程fiber
function prepareFreshStack(root, lanes) {
  // 重制上次render阶段的状态
  root.finishedWork = null;
  root.finishedLanes = NoLanes;

  const timeoutHandle = root.timeoutHandle;
  if(timeoutHandle !== noTimeout) {
    root.timeoutHandle = noTimeout;
    cancelTimeout(timeoutHandle);
  }

  if(workInProgress !== null) {
    let interruptedWork = workInProgress.return;
    while(interruptedWork !== null) {
      unwindInterruptedWork(interruptedWork);
      interruptedWork = interruptedWork.return;
    }
  }

  // 创建运行过程中的全局变量
  workInProgressRoot = root;
  // 创建当前过程Fiber节点
  workInProgress = createWorkInProgress(root.current, null);
  // 当前过程优先级
  workInProgressRootRenderLanes = subtreeRenderLanes = workInProgressRootIncludedLanes = lanes;
  workInProgressRootExitStatus = RootIncomplete;
  workInProgressRootFatalError = null;
  workInProgressRootSkippedLanes = NoLanes;
  workInProgressRootUpdatedLanes = NoLanes;
  workInProgressRootPingedLanes = NoLanes;
}

function renderRootSync(root, lanes) {
  const prevExecutionContext = executionContext;
  executionContext |= RenderContext;
  if(workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes) {
    prepareFreshStack(root, lanes);
  }
  do{
    try {
      // 进入Render阶段
      workLoopSync();
      break;
    } catch (err) {

    }
  } while(true)

  // 恢复之前执行上下文
  executionContext = prevExecutionContext;
  // 重制当前过程Root和优先级以便下次重新创建
  workInProgressRoot = null;
  workInProgressRootRenderLanes = NoLanes;
  return workInProgressRootExitStatus;
}

function commitRoot(root) {
  const renderPriorityLevel = getCurrentPriorityLevel();
  runWithPriority(
    ImmediateSchedulerPriority,
    commitRootImpl.bind(null, root, renderPriorityLevel)
  );
  return null;
}

function commitRootImpl(root, renderPriorityLevel) {
  do{
    flushPassiveEffects();
  } while(rootWithPendingPassiveEffects !== null)
  const finishedWork = root.finishedWork; 
  const lanes = root.finishedLanes;

  if(finishedWork === null) {
    return null;
  }

  root.finishedWork = null;
  root.finishedLanes = NoLanes;


  root.callbackNode = null;

  let remainingLanes =  mergeLanes(finishedWork.lanes, finishedWork.childLanes);
  markRootFinished(root, remainingLanes);

  if(root === workInProgressRoot) {
    workInProgressRoot = null;
    workInProgress = null;
    workInProgressRootRenderLanes = NoLanes;
  }

  const subtreeHasEffects = 
  (
    finishedWork.subtreeFlags  & 
    (
      BeforeMutationMask | MutationMask | LayoutMask | PassiveMask
    )
  ) !== NoFlags;

  const rootHasEffect = (
    finishedWork.flags & (
      BeforeMutationMask | MutationMask | LayoutMask | PassiveMask
    )
  ) !== NoFlags;

  if(subtreeHasEffects || rootHasEffect) {
    let previousLanePriority;

    const prevExecutionContext = executionContext;
    executionContext |= CommitContext;

    ReactCurrentOwner.current = null;

    commitBeforeMutationEffects(finishedWork);

    commitMutationEffects(finishedWork, root, renderPriorityLevel);

  
    resetAfterCommit(root.containerInfo);
    
    root.current = finishedWork;
    
    recursivelyCommitLayoutEffects(finishedWork, root);

    // If there are pending passive effects, schedule a callback to process them.
    if (
      (finishedWork.subtreeFlags & PassiveMask) !== NoFlags ||
      (finishedWork.flags & PassiveMask) !== NoFlags
    ) {
      if (!rootDoesHavePassiveEffects) {
        rootDoesHavePassiveEffects = true;
        scheduleCallback(NormalSchedulerPriority, () => {
          flushPassiveEffects();
          return null;
        });
      }
    }

    // requestPaint();

    executionContext = prevExecutionContext;
  } else  {
    root.current = finishedWork;
  }

  const rootDidHavePassiveEffects = rootDoseHavePassiveEffects;
  if(rootDoseHavePassiveEffects)  {
    rootDoseHavePassiveEffects = false;
    rootWithPendingPassiveEffects  = root;
    pendingPassiveEffectsLanes  = lanes;
    pendingPassiveEffectsRenderPriority = renderPriorityLevel;
  }

  remainingLanes = root.pendingLanes;

  if(remainingLanes !== NoLanes) {

  }

  if(remainingLanes ===  SyncLane) {

  }

  ensureRootIsScheduled(root, now());

  if((executionContext & LegacyUnbatchedContext) !== NoContext) {
    return null;
  }

  flushSyncCallbackQueue();

  return null;

}

function  ensureRootIsScheduled(root, currentTime) {
  const existingCallbackNode = root.callbackNode;
  markStarvedLanesAsExpired(root, currentTime);

  const nextLanes = getNextLanes(
    root,
    root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes
  );
  
  const newCallbackPriority = returnNextLanesPriority();

  if(nextLanes === NoLanes) {
    if(existingCallbackNode !== null) {
      cancelCallback(existingCallbackNode);
      root.callbackNode = null;
      root.callbackPriority = NoLanePriority;
    }
    return;
  }

  if(existingCallbackNode !== null) {
    const existingCallbackPriority = root.callbackPriority;
    if(existingCallbackPriority === newCallbackPriority) {
      return;
    }

    cancelCallback(existingCallbackNode);
  }

  let newCallbackNode;
  if(newCallbackPriority === SyncLanePriority) {
    newCallbackNode = scheduleSyncCallback(
      performSyncWorkOnRoot.bind(null, root)
    );
  } else if(newCallbackPriority === SyncBatchedLanePriority) {
    newCallbackNode = scheduleCallback(
      ImmediateSchedulerPriority,
      performSyncWorkOnRoot.bind(null, root)
    )
  } else {
    // concurrent
  }

  root.callbackPriority = newCallbackPriority;
  root.callbackNode = newCallbackNode;
}

export function markSkippedUpdateLanes(lane) {
  workInProgressRootSkippedLanes = mergeLanes(
    lane,
    workInProgressRootSkippedLanes
  );
}

export function schedulePassiveEffectCallback() {
  if(!rootDoseHavePassiveEffects) {
    rootDoseHavePassiveEffects = true;
    scheduleCallback(
      NormalSchedulerPriority,
      () => {
        flushPassiveEffects();
        return null;
      }
    );
  }
}

function commitBeforeMutationEffects(firstChild) {
  let fiber = firstChild;
  // 递归处理fiber
  while(fiber !== null) {
    // if(fiber.deletions !== null) {
    //   commitBeforeMutationEffectsDeletions(fiber.deletions);
    // }
    if(fiber.child !== null) {
      const primarySubtreeFlags = fiber.subtreeFlags & BeforeMutationMask;
      console.log("====>>>>>commitBeforeMutationEffects", fiber, "\n", turn2(fiber.subtreeFlags, 18), "\n", turn2(BeforeMutationMask, 18), primarySubtreeFlags);
      if(primarySubtreeFlags !== NoFlags) {
        commitBeforeMutationEffects(fiber.child);
      }
    }

    try {
      commitBeforeMutationEffectsImpl(fiber);
    } catch(e) {
      
    }

    fiber = fiber.sibling;
  }
}

function commitBeforeMutationEffectsImpl(fiber) {
  const current = fiber.alternate;
  const flags = fiber.flags;

  if((flags & Passive) !== NoFlags) {
    if(!rootDoseHavePassiveEffects) {
      rootDoseHavePassiveEffects = true;
      scheduleCallback(
        NormalSchedulerPriority,
        () => {
          flushPassiveEffects();
          return null;
        }
      );
    }
  }

}

function commitMutationEffects(firstChild, root, renderPriorityLevel) {
  let fiber = firstChild;
  while(fiber !== null) {
    if(fiber.child !== null) {
      const mutationFlags = fiber.subtreeFlags & MutationMask;
      // console.log("====>>>>>commitMutationEffects", fiber, "\n", turn2(fiber.subtreeFlags, 18), "\n", turn2(MutationMask, 18), mutationFlags);
      if(mutationFlags !== NoFlags) {
        commitMutationEffects(fiber.child, root, renderPriorityLevel);
      }
    }

    try{
      commitMutationEffectsImpl(fiber, root, renderPriorityLevel);
    } catch(e) {

    }
    fiber = fiber.sibling;
  }
}

function commitMutationEffectsImpl(fiber, root, renderPriorityLevel) {
  const flags = fiber.flags;
  const primaryFlags = flags & (Placement | Update);
  switch(primaryFlags) {
    case Placement:
      commitPlacement(fiber);
      fiber.flags &= ~Placement;
      break;
    case PlacementAndUpdate:
      {
        commitPlacement(fiber);
        fiber.flags &= ~Placement;
        const current = fiber.alternate;
        commitWork(current, fiber);
        break;
      }
    case Update: {
      const current = fiber.alternate;
      commitWork(current, fiber);
      break;
    }
  }
}

function commitLayoutEffects(root, committedLanes) {
  while(nextEffect !== null) {
    const flags = nextEffect.flags;
    if(flags & (Update | Callback)) {
      const current = nextEffect.alternate;
      commitLayoutEffectOnFiber(root, current, nextEffect, committedLanes);
    }

    nextEffect = nextEffect.nextEffect;
  }
}

// function commitBeforeMutationEffectsDeletions(deletions) {
//   for(let i = 0; i < deletions.length; i++) {
//     const fiber = deletions[i];

//   }
// }

function performSyncWorkOnRoot(root) {
  flushPassiveEffects();
  let lanes;
  let existStatus;

  if(
    root === workInProgressRoot
    && includesSomeLane(root.exporedLanes, workInProgressRootRenderLanes)
  ) {
    lanes = workInProgressRootRenderLanes;
    existStatus = renderRootSync(root, lanes);
    if(includesSomeLane(
      workInProgressRootIncludedLanes,
      workInProgressRootUpdatedLanes
    )) {
      lanes = getNextLanes(root, lanes);
      existStatus = renderRootSync(root, lanes);
    }
  } else {
    lanes = getNextLanes(root, NoLanes);
    existStatus = renderRootSync(root, lanes);
  }


  const finishedWork = root.current.alternate;
  root.finishedWork = finishedWork;
  root.finishedLanes = lanes;
  console.log("====>>>>beforeCommitRoot", root);
  commitRoot(root);
  ensureRootIsScheduled(root, now());

  return null;
}

function scheduleUpdateOnFiber(fiber, lane, eventTime) {
  const root = markUpdateLaneFromFiberToRoot(fiber, lane);
  markRootUpdated(root, lane, eventTime);
  if(root === workInProgressRoot) {
    if(deferRenderPhaseUpdateToNextBatch || (executionContext & RenderContext) === NoContext) {
      workInProgressRootUpdatedLanes = mergeLanes(
        workInProgressRootUpdatedLanes,
        lane
      );
    }
  }

  const priorityLevel = getCurrentPriorityLevel();
  if(lane === SyncLane) {
    if(
      (executionContext & LegacyUnbatchedContext) !== NoContext &&
      (executionContext & (RenderContext | CommitContext)) === NoContext
    ) {
      performSyncWorkOnRoot(root);
    } else {
      ensureRootIsScheduled(root, eventTime);
      // schedulePendingInteractions(root, lane);
      if(executionContext === NoContext) {
        resetRenderTimer();
        flushSyncCallbackQueue();
      }
    }
  }

  mostRecentlyUpdatedRoot = root;
}

function resetRenderTimer() {
  workInProgressRootRenderTargetTime = now() + RENDER_TIMEOUT_MS;
}

function schedulePendingInteractions(root, lane) {

}

function detachFiberAfterEffects(fiber) {
  fiber.sibling = null;
  fiber.stateNode = null;
}

export function enqueuePendingPassiveHookEffectMount(fiber, effect) {
  pendingPassiveHookEffectsMount.push(effect, fiber);
  if(!rootDoseHavePassiveEffects) {

  }
}

function flushPassiveEffects() {
  if(pendingPassiveEffectsRenderPriority !== NoSchedulerPriority) {
    const priorityLevel = pendingPassiveEffectsRenderPriority > NormalSchedulerPriority ? 
      NormalSchedulerPriority : pendingPassiveEffectsRenderPriority; 
    pendingPassiveEffectsRenderPriority = NoSchedulerPriority;
    if(decoupleUpdatePriorityFromScheduler) {

    } else {
      runWithPriority(priorityLevel, flushPassiveEffectsImpl);
    }
  }
}

function flushPassiveEffectsImpl() {
  if(rootWithPendingPassiveEffects === null) {
    return false;
  }

  const root = rootWithPendingPassiveEffects;
  const lanes = pendingPassiveEffectsLanes;
  rootWithPendingPassiveEffects = null;
  pendingPassiveEffectsLanes = NoLanes;

  const prevExecutionContext = executionContext; 
  executionContext |= CommitContext;

  flushPassiveUnmountEffects(root.current);
  flushPassiveMountEffects(root, root.current);

  executionContext = prevExecutionContext;

  flushSyncCallbackQueue();

  nestedPassiveUpdateCount =
  rootWithPendingPassiveEffects === null ? 0 : nestedPassiveUpdateCount + 1;

  return true;
}

function flushPassiveUnmountEffects(firstChild) {
  let fiber = firstChild;
  while(fiber !== null) {
    const deletions = fiber.deletions;
    if(deletions !== null) {

    }

    const child = fiber.child;
    if(child !== null) {
      const passiveFlags = fiber.subtreeFlags & PassiveMask;
      if(passiveFlags !== NoFlags) {
        flushPassiveUnmountEffects(child);
      }
    }

    const primaryFlags = fiber.flags & Passive;
    if(primaryFlags !== NoFlags) {
      commitPassiveUnmountOnFiber(fiber);
    }

    fiber = fiber.sibling;

  }
}

function flushPassiveMountEffects(root, firstChild) {
  let fiber = firstChild;
  while(fiber !== null) {
    const primarySubtreeFlags = fiber.subtreeFlags & PassiveMask;
    if(fiber.child !== null && primarySubtreeFlags !== NoFlags) {
      flushPassiveMountEffects(root, fiber.child);
    }

    if((fiber.flags & Passive) !== NoFlags) {
      commitPassiveMountOnFiber(root, fiber);
    }

    fiber = fiber.sibling;
  }
}

export {
  unbatchedUpdates,
  requestEventTime,
  requestUpdateLane,
  scheduleUpdateOnFiber
}