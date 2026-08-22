(() => {
  const NativeDate = Date;
  const OFFSET = 7 * 24 * 60 * 60 * 1000;
  const shiftedNow = () => NativeDate.now() + OFFSET;

  const FakeDate = new Proxy(NativeDate, {
    apply() {
      return new NativeDate(shiftedNow()).toString();
    },
    construct(target, args, newTarget) {
      const dateArgs = args.length ? args : [shiftedNow()];
      return Reflect.construct(target, dateArgs, newTarget === FakeDate ? target : newTarget);
    },
    get(target, property, receiver) {
      return property === 'now' ? shiftedNow : Reflect.get(target, property, receiver);
    }
  });

  window.Date = FakeDate;
})();
