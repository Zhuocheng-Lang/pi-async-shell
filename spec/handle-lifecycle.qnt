/// The completion and promotion contract of pi-async-shell, as a state machine.
///
/// This is not the implementation. It is the smallest model that can answer the
/// questions a test cannot enumerate: can one settle be reported twice, can
/// ownership move twice, can a session execution still report after its owner
/// reaped it.
///
/// Contracts modelled:
///   C3   completion is an event, never a poll
///   C9   shell_await is the short form; ending the turn is the long form
///   R1   the scope decides who may reap, the wait decides who may proceed
///
/// Every action states its frame explicitly. Quint can infer an unprimed
/// variable as unchanged, but the inference stops at a disjunction, and a
/// specification that hides which variables an action touches is the thing this
/// model exists to avoid.
///
/// Run:  quint run spec/handle-lifecycle.qnt --max-samples=5000 --max-steps=20 --invariant=invariants
module handle_lifecycle {
  /// A handle is starting, running, or terminal.
  type Status = Starting | Running | Completed | Cancelled

  var status: Status
  /// false is scope session, true is scope workspace.
  var workspace: bool
  /// Whether the owning Pi process is alive.
  var piAlive: bool
  /// Completion records queued but not yet resolved.
  var pending: int
  /// Completion messages delivered to the conversation.
  var delivered: int
  /// Whether a tool result already carried the settle.
  var claimed: bool
  /// How many times ownership moved. One-way, so 0 or 1.
  var promotions: int

  action init = all {
    status' = Starting,
    workspace' = false,
    piAlive' = true,
    pending' = 0,
    delivered' = 0,
    claimed' = false,
    promotions' = 0,
  }

  /// Admission under session scope, the default.
  action admitSession = all {
    status == Starting,
    status' = Running,
    workspace' = workspace,
    piAlive' = piAlive,
    pending' = pending,
    delivered' = delivered,
    claimed' = claimed,
    promotions' = promotions,
  }

  /// Admission under workspace scope, chosen at start.
  action admitWorkspace = all {
    status == Starting,
    status' = Running,
    workspace' = true,
    piAlive' = piAlive,
    pending' = pending,
    delivered' = delivered,
    claimed' = claimed,
    promotions' = promotions,
  }

  /// Promotion moves ownership and keeps the process. There is no demotion, so
  /// the model has no narrowing action at all.
  action promote = all {
    status == Running,
    not(workspace),
    status' = status,
    workspace' = true,
    piAlive' = piAlive,
    pending' = pending,
    delivered' = delivered,
    claimed' = claimed,
    promotions' = promotions + 1,
  }

  /// The process exits on its own. That queues exactly one completion record.
  action settle = all {
    status == Running,
    status' = Completed,
    workspace' = workspace,
    piAlive' = piAlive,
    pending' = pending + 1,
    delivered' = delivered,
    claimed' = claimed,
    promotions' = promotions,
  }

  /// A shell_await observes a running execution settle, so the tool result
  /// carries the outcome and no record is queued.
  action awaitObservesSettle = all {
    status == Running,
    status' = Completed,
    workspace' = workspace,
    piAlive' = piAlive,
    pending' = pending,
    delivered' = delivered,
    claimed' = true,
    promotions' = promotions,
  }

  /// A shell_await claims a record that finalize already queued. The claim marks
  /// the record; it does not remove it, because suppression and retrieval are
  /// two different steps and only the second one may drop bytes.
  action awaitClaimsQueued = all {
    pending > 0,
    status' = status,
    workspace' = workspace,
    piAlive' = piAlive,
    pending' = pending,
    delivered' = delivered,
    claimed' = true,
    promotions' = promotions,
  }

  /// Pi exits while a session execution runs. The scope owes the cleanup, so the
  /// owner reaps it and records the outcome.
  action piExitCancelsSession = all {
    piAlive,
    status == Running,
    not(workspace),
    status' = Cancelled,
    workspace' = workspace,
    piAlive' = false,
    pending' = pending + 1,
    delivered' = delivered,
    claimed' = claimed,
    promotions' = promotions,
  }

  /// Pi exits while a workspace execution runs. Nothing is reaped.
  action piExitKeepsWorkspace = all {
    piAlive,
    workspace,
    status == Running,
    status' = status,
    workspace' = workspace,
    piAlive' = false,
    pending' = pending,
    delivered' = delivered,
    claimed' = claimed,
    promotions' = promotions,
  }

  /// Pi exits when nothing is running. Nothing changes but the owner's liveness.
  action piExitQuiet = all {
    piAlive,
    status != Running,
    status' = status,
    workspace' = workspace,
    piAlive' = false,
    pending' = pending,
    delivered' = delivered,
    claimed' = claimed,
    promotions' = promotions,
  }

  /// shell_cancel from the agent, allowed at either scope. It is the only way to
  /// stop a workspace execution, because there is no demotion.
  action cancel = all {
    status == Running,
    status' = Cancelled,
    workspace' = workspace,
    piAlive' = piAlive,
    pending' = pending + 1,
    delivered' = delivered,
    claimed' = claimed,
    promotions' = promotions,
  }

  /// A record that no tool result claimed becomes one completion message.
  action deliver = all {
    pending > 0,
    not(claimed),
    status' = status,
    workspace' = workspace,
    piAlive' = piAlive,
    pending' = pending - 1,
    delivered' = delivered + 1,
    claimed' = claimed,
    promotions' = promotions,
  }

  /// A record a tool result already carried is dropped, never delivered.
  action dropClaimed = all {
    pending > 0,
    claimed,
    status' = status,
    workspace' = workspace,
    piAlive' = piAlive,
    pending' = pending - 1,
    delivered' = delivered,
    claimed' = claimed,
    promotions' = promotions,
  }

  /// The transition relation the simulator explores.
  action step = any {
    admitSession,
    admitWorkspace,
    promote,
    settle,
    awaitObservesSettle,
    awaitClaimsQueued,
    piExitCancelsSession,
    piExitKeepsWorkspace,
    piExitQuiet,
    cancel,
    deliver,
    dropClaimed,
  }

  /// C3 and C9 together: one settle, one report, whether the report arrives in a
  /// tool result or as a message.
  val oneReportPerExecution = delivered + (if (claimed) 1 else 0) <= 1

  /// Ownership moves at most once. The model has no narrowing action, so this
  /// invariant is what proves the absence rather than asserting it.
  val promotionIsOneWay = promotions <= 1

  /// Every invariant the simulator checks in one run.
  val invariants = oneReportPerExecution and promotionIsOneWay
}
