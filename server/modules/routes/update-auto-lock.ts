export type AutoUpdateLock = {
  tryAcquire: () => boolean;
  release: () => void;
  isHeld: () => boolean;
};

export function createAutoUpdateLock(): AutoUpdateLock {
  let held = false;
  return {
    tryAcquire: () => {
      if (held) return false;
      held = true;
      return true;
    },
    release: () => {
      held = false;
    },
    isHeld: () => held,
  };
}
