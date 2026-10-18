import { State, StateMachine } from './StateMachine.js';

export class WaitingState extends State {
  constructor(engine) {
    super('waiting');
    this.engine = engine;
  }
}

export class WarmupState extends State {
  constructor(engine) {
    super('warmup');
    this.engine = engine;
  }
}

export class CountdownState extends State {
  constructor(engine) {
    super('countdown');
    this.engine = engine;
  }
}

export class RoundState extends State {
  constructor(engine) {
    super('round');
    this.engine = engine;
  }
}

export class SummaryState extends State {
  constructor(engine) {
    super('summary');
    this.engine = engine;
  }
}

export class MatchStateMachine extends StateMachine {
  constructor(engine) {
    super();
    this.engine = engine;
    this.addState(new WaitingState(engine));
    this.addState(new WarmupState(engine));
    this.addState(new CountdownState(engine));
    this.addState(new RoundState(engine));
    this.addState(new SummaryState(engine));
    this.setState('waiting');
  }
}
