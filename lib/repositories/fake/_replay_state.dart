import 'dart:async';

/// In-memory state holder for fake repositories. Wraps a broadcast
/// `StreamController` and replays the latest value to new subscribers so
/// ViewModels that subscribe AFTER a mutation still see the current data.
class ReplayState<T> {
  ReplayState(T initial) : _value = initial;

  T _value;
  T get value => _value;

  final _controller = StreamController<T>.broadcast();

  Stream<T> get stream async* {
    yield _value;
    yield* _controller.stream;
  }

  void update(T newValue) {
    _value = newValue;
    _controller.add(newValue);
  }

  void dispose() => _controller.close();
}
