import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'vault_entry.dart';

class VaultController extends ChangeNotifier {
  VaultController({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('heavenkey/vault');
  final MethodChannel _channel;
  List<VaultEntry> _entries = [];
  List<VaultEntry> get entries => List.unmodifiable(_entries);
  bool unlocked = false, busy = false;
  Map<Object?, Object?> status = {};
  String? error;
  int _generation = 0;
  Timer? _expiry;
  bool _disposed = false;
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> refreshStatus() async {
    try {
      status = await _channel.invokeMapMethod<Object?, Object?>('status') ?? {};
    } on MissingPluginException {
      status = {'available': false, 'secureDevice': false};
    } on PlatformException {
      error = 'Gerätesicherheit konnte nicht geprüft werden.';
    }
    _notify();
  }

  Future<bool> _perform(Future<void> Function(int generation) action) async {
    if (busy || _disposed) return false;
    final generation = _generation;
    busy = true;
    error = null;
    _notify();
    try {
      await action(generation);
      return generation == _generation && !_disposed;
    } on PlatformException catch (failure) {
      if (generation != _generation || _disposed) return false;
      error = switch (failure.code) {
        'cancelled' => 'Entsperren abgebrochen.',
        'device_not_secure' => 'Zuerst eine Gerätesperre einrichten.',
        'locked' => 'Bitte den Tresor erneut entsperren.',
        'corrupt_vault' =>
          'Tresor konnte nicht gelesen werden. Daten bleiben erhalten.',
        'vault_full' =>
          'Speichergrenze erreicht. Der Eintrag wurde nicht gespeichert.',
        _ => 'Aktion fehlgeschlagen. Der Tresor bleibt geschützt.',
      };
      if (failure.code == 'vault_full') {
        return false;
      }
      await lock(keepError: true);
      return false;
    } on MissingPluginException {
      error = 'Diese Funktion benötigt die native Android- oder iOS-App.';
      await lock(keepError: true);
      return false;
    } on FormatException {
      error = 'Ungültige Tresordaten. Daten bleiben erhalten.';
      await lock(keepError: true);
      return false;
    } finally {
      busy = false;
      _notify();
    }
  }

  Future<bool> unlock() => _perform((generation) async {
    final values = await _channel.invokeListMethod<Object?>('unlock');
    if (generation != _generation || _disposed) {
      await _channel.invokeMethod<void>('lock');
      return;
    }
    if (values == null || values.length > 500) {
      throw const FormatException('Ungültiger Tresor.');
    }
    final parsed = <VaultEntry>[];
    final ids = <String>{};
    for (final value in values) {
      if (value is! Map<Object?, Object?>) {
        throw const FormatException('Ungültiger Eintrag.');
      }
      final entry = VaultEntry.fromMap(value);
      if (!ids.add(entry.id)) throw const FormatException('Doppelte ID.');
      parsed.add(entry);
    }
    _entries = parsed;
    unlocked = true;
    _expiry?.cancel();
    _expiry = Timer(const Duration(seconds: 60), lock);
  });

  Future<bool> save(VaultEntry entry) => _perform((generation) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    entry.validate();
    final index = _entries.indexWhere((old) => old.id == entry.id);
    if (index == -1 && _entries.length >= 500) {
      throw const FormatException('Tresor voll.');
    }
    await _channel.invokeMethod<void>('save', entry.toMap());
    if (generation != _generation || _disposed) return;
    if (index == -1) {
      _entries.add(entry);
    } else {
      _entries[index] = entry;
    }
  });
  Future<bool> delete(String id) => _perform((generation) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    await _channel.invokeMethod<void>('delete', {'id': id});
    if (generation == _generation && !_disposed) {
      _entries.removeWhere((entry) => entry.id == id);
    }
  });
  Future<bool> copyPassword(String id) => _perform((_) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    await _channel.invokeMethod<void>('copyPassword', {'id': id});
  });
  Future<bool> enableAutofill() => _perform((_) async {
    await _channel.invokeMethod<void>('enableAutofill');
  });
  Future<void> lock({bool keepError = false}) async {
    _generation++;
    _expiry?.cancel();
    _entries = [];
    unlocked = false;
    if (!keepError) error = null;
    _notify();
    try {
      await _channel.invokeMethod<void>('lock');
    } on PlatformException {
      error =
          'Sperre lokal aktiv. Native Sperre konnte nicht bestätigt werden.';
      _notify();
    } on MissingPluginException {
      // An unsupported host holds no native vault session.
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _expiry?.cancel();
    _entries = [];
    super.dispose();
  }
}
