/**
 * StateMachine — Generic finite state machine pattern for match phases and player states.
 */
export class State {
  constructor(name) {
    this.name = name;
  }
  enter() {}
  exit() {}
  update() {}
}

export class StateMachine {
  constructor(initialState = null) {
    this.currentState = null;
    this.states = new Map();
    if (initialState) {
      this.addState(initialState);
      this.setState(initialState.name);
    }
  }

  addState(state) {
    this.states.set(state.name, state);
    return this;
  }

  setState(name, payload = null) {
    const nextState = this.states.get(name);
    if (!nextState || nextState === this.currentState) return;

    if (this.currentState) {
      this.currentState.exit();
    }

    this.currentState = nextState;
    this.currentState.enter(payload);
  }

  update(dt) {
    if (this.currentState) {
      this.currentState.update(dt);
    }
  }

  get stateName() {
    return this.currentState ? this.currentState.name : null;
  }
}
