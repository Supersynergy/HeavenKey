import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'backup_preview.dart';
import 'form_profile.dart';
import 'vault_entry.dart';

class VaultController extends ChangeNotifier {
  VaultController({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('heavenkey/vault');
  final MethodChannel _channel;
  List<VaultEntry> _entries = [];
  List<VaultEntry> get entries => List.unmodifiable(_entries);
  List<FormProfile> _profiles = [];
  List<FormProfile> get profiles => List.unmodifiable(_profiles);
  List<Map<String, String>> appBindings = [];
  bool unlocked = false, busy = false;
  Map<Object?, Object?> status = {};
  String? error;
  Map<Object?, Object?> connection = {};
  List<Map<Object?, Object?>> websitePasskeys = [];
  int _generation = 0;
  Timer? _expiry;
  Timer? _archiveExpiry;
  String? _selectedBackup;
  String? get selectedBackup => _selectedBackup;
  String? backupNotice;
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

  Future<bool> _perform(
    Future<void> Function(int generation) action, {
    bool backup = false,
    bool clearError = true,
  }) async {
    if (busy || _disposed) return false;
    final generation = _generation;
    busy = true;
    if (clearError) error = null;
    _notify();
    try {
      await action(generation);
      return generation == _generation && !_disposed;
    } on PlatformException catch (failure) {
      if (generation != _generation || _disposed) return false;
      error = switch (failure.code) {
        'cancelled' =>
          backup ? 'Sicherungsaktion abgebrochen.' : 'Entsperren abgebrochen.',
        'device_not_secure' => 'Zuerst eine Gerätesperre einrichten.',
        'locked' => 'Bitte den Tresor erneut entsperren.',
        'corrupt_vault' =>
          'Tresor konnte nicht gelesen werden. Daten bleiben erhalten.',
        'vault_full' =>
          'Speichergrenze erreicht. Der Eintrag wurde nicht gespeichert.',
        'invalid_profile' =>
          'Formularprofil ist ungültig. Bitte die Eingaben prüfen.',
        'app_changed' => 'Die App-Signatur hat sich geändert. Bitte die Freigabe erneut prüfen.',
        'invalid_key' =>
          'Wiederherstellungsschlüssel stimmt nicht. Bitte prüfen.',
        'invalid_archive' =>
          'Sicherung ist ungültig oder beschädigt. Der Tresor bleibt erhalten.',
        'too_large' => 'Sicherung überschreitet die Speichergrenze von 24 MiB.',
        'vault_changed' =>
          'Tresor wurde geändert. Bitte die Vorschau neu laden.',
        'backup_busy' => 'Eine Sicherungsaktion läuft bereits. Bitte warten.',
        'backup_incomplete' => 'Wiederherstellung unvollständig. Entsperre erneut, prüfe eine neue Vorschau und wiederhole die Wiederherstellung. Die Sicherungsdatei bleibt unverändert.',
        'browser_untrusted' =>
          'Dieser Standardbrowser ist noch nicht freigegeben.',
        'sync_conflict' => 'Synchronisierungskonflikt. Beide Stände bleiben erhalten. Prüfe die Änderungen auf beiden Geräten.',
        'sync_conflict_changed' =>
          'Der Konfliktstand wurde geändert. Bitte die neue Auswahl prüfen.',
        'sync_certificate_mismatch' => 'Zertifikat stimmt nicht mit der Kopplung überein. Es wurden keine Daten freigegeben.',
        'sync_denied' =>
          'Geräteverbindung ist abgelaufen oder wurde am Desktop widerrufen.',
        'sync_unavailable' => 'Desktop nicht erreichbar. Öffne HeavenKey dort und prüfe das gemeinsame Netzwerk.',
        'sync_rollback' => 'Der Desktop meldet einen älteren Synchronisierungsstand. Bitte die Verbindung prüfen.',
        'sync_busy' => 'Eine Synchronisierung läuft bereits.',
        'sync_already_connected' =>
          'Zuerst die vorhandene Desktop-Verbindung lokal entfernen.',
        'invalid_sync_pairing' =>
          'Kopplungscode ist ungültig. Erzeuge ihn am Desktop erneut.',
        'passkeys_unavailable' =>
          'Website-Passkeys benötigen Android 14 oder neuer.',
        'browser_configuration_unavailable' => 'Bitte im Browser die Einstellungen für Autofill öffnen und HeavenKey auswählen.',
        _ => 'Aktion fehlgeschlagen. Der Tresor bleibt geschützt.',
      };
      if (failure.code == 'vault_full' ||
          (backup &&
              const {
                'invalid_key',
                'invalid_archive',
                'too_large',
                'vault_changed',
                'backup_busy',
                'cancelled',
                'sync_conflict',
                'sync_conflict_changed',
                'sync_certificate_mismatch',
                'sync_denied',
                'sync_unavailable',
                'sync_rollback',
                'sync_busy',
                'sync_already_connected',
                'invalid_sync_pairing',
              }.contains(failure.code))) {
        return false;
      }
      await lock(keepError: true);
      return false;
    } on MissingPluginException {
      if (generation != _generation || _disposed) return false;
      error = 'Diese Funktion benötigt die native Android- oder iOS-App.';
      await lock(keepError: true);
      return false;
    } on FormatException {
      if (generation != _generation || _disposed) return false;
      error = backup
          ? 'Sicherung konnte nicht geprüft werden. Der Tresor bleibt erhalten.'
          : 'Ungültige Tresordaten. Daten bleiben erhalten.';
      if (backup) return false;
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
    _entries = _parseEntries(values);
    await _refreshFormData(generation);
    if (generation != _generation || _disposed) return;
    unlocked = true;
    _expiry?.cancel();
    _expiry = Timer(const Duration(seconds: 60), lock);
  });

  List<VaultEntry> _parseEntries(List<Object?>? values) {
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
    return parsed;
  }

  Future<void> _refreshFormData(int generation) async {
    if (status['formsSupported'] != true) return;
    final data = await _channel.invokeMapMethod<Object?, Object?>('formData');
    if (generation != _generation || _disposed) return;
    final profiles = data?['profiles'], bindings = data?['appBindings'];
    if (profiles is! List ||
        profiles.length > 100 ||
        bindings is! List ||
        bindings.length > 1000) {
      throw const FormatException('Ungültige Formularprofile.');
    }
    final parsed = profiles.map((value) {
      if (value is! Map<Object?, Object?>) {
        throw const FormatException('Ungültiges Formularprofil.');
      }
      return FormProfile.fromMap(value);
    }).toList();
    if (parsed.map((value) => value.id).toSet().length != parsed.length) {
      throw const FormatException('Doppelte Profil-ID.');
    }
    final apps = bindings.map((value) {
      if (value is! Map ||
          value.length != 3 ||
          value.keys.toSet().difference({
            'entryId',
            'packageName',
            'certificates',
          }).isNotEmpty ||
          value.values.any((field) => field is! String)) {
        throw const FormatException('Ungültige App-Freigabe.');
      }
      return Map<String, String>.from(value);
    }).toList();
    _profiles = parsed;
    appBindings = apps;
  }

  Future<bool> saveProfile(FormProfile profile) => _perform((generation) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    profile.validate();
    await _channel.invokeMethod<void>('saveProfile', profile.values);
    await _refreshFormData(generation);
  });
  Future<bool> deleteProfile(String id) => _perform((generation) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    await _channel.invokeMethod<void>('deleteProfile', {'id': id});
    await _refreshFormData(generation);
  });
  Future<bool> revokeApp(String packageName) => _perform((generation) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    await _channel.invokeMethod<void>('revokeApp', {
      'packageName': packageName,
    });
    await _refreshFormData(generation);
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
    status = {...status, 'hasVault': true};
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

  Future<bool> configureBrowser() => _perform((_) async {
    await _channel.invokeMethod<void>('configureBrowser');
  });

  Future<bool> configureDeviceSecurity() => _perform((_) async {
    await _channel.invokeMethod<void>('configureDeviceSecurity');
  });

  Future<bool> refreshConnections() => _perform(
    (generation) async {
      if (!unlocked) return;
      final value = await _channel.invokeMapMethod<Object?, Object?>(
        'connectedStatus',
      );
      if (generation == _generation && !_disposed && value != null) {
        _acceptConnection(value);
      }
    },
    backup: true,
    clearError: false,
  );

  void _acceptConnection(Map<Object?, Object?> value) {
    final keys = value['passkeys'];
    if (value['connected'] is! bool ||
        keys is! List ||
        keys.length > 500 ||
        keys.any((key) => key is! Map<Object?, Object?>)) {
      throw const FormatException('Ungültige Geräteinformationen.');
    }
    connection = Map.of(value)
      ..remove('passkeys')
      ..remove('entries');
    websitePasskeys = keys
        .cast<Map<Object?, Object?>>()
        .map(Map<Object?, Object?>.of)
        .toList();
  }

  Future<bool> synchronize({
    String? code,
    String? resolution,
    String? conflictToken,
  }) => _perform((generation) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    final value = await _channel.invokeMapMethod<Object?, Object?>(
      code == null ? 'syncDesktop' : 'connectDesktop',
      code == null
          ? {'resolution': resolution, 'conflictToken': conflictToken}
          : {'code': code},
    );
    if (generation != _generation || _disposed) return;
    if (value == null) {
      throw const FormatException('Ungültige Synchronisierung.');
    }
    _entries = _parseEntries((value['entries'] as List).cast<Object?>());
    _acceptConnection(value);
    final omitted = value['unsupported'];
    backupNotice = omitted is int && omitted > 0
        ? 'Synchronisiert. $omitted Desktop-Einträge außerhalb des mobilen Formats bleiben am Desktop erhalten.'
        : 'Logins und Website-Passkeys synchronisiert.';
  }, backup: true);

  Future<bool> disconnectDesktop() => _perform((_) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    await _channel.invokeMethod<void>('disconnectDesktop');
    connection = {'connected': false};
  }, backup: true);

  Future<bool> deleteWebsitePasskey(String id) => _perform((_) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    await _channel.invokeMethod<void>('deleteWebsitePasskey', {'id': id});
    websitePasskeys.removeWhere((key) => key['id'] == id);
  }, backup: true);

  Future<bool> enablePasskeys() => _perform((_) async {
    await _channel.invokeMethod<void>('enablePasskeys');
  });

  Future<String?> newBackupKey() async {
    String? key;
    final accepted = await _perform((generation) async {
      if (!unlocked) throw PlatformException(code: 'locked');
      final value = await _channel.invokeMethod<Object?>('newBackupKey');
      if (generation != _generation || _disposed) return;
      if (value is! String ||
          value.length > 128 ||
          !RegExp(r'^hk1_[A-Za-z0-9_-]+$').hasMatch(value)) {
        throw const FormatException('Ungültiger Schlüssel.');
      }
      key = value;
    }, backup: true);
    return accepted ? key : null;
  }

  Future<bool> copyBackupKey(String recoveryKey) => _perform((_) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    await _channel.invokeMethod<void>('copyBackupKey', {
      'recoveryKey': recoveryKey,
    });
  }, backup: true);

  Future<String?> createBackup(String recoveryKey) async {
    String? envelope;
    final accepted = await _perform((generation) async {
      if (!unlocked) throw PlatformException(code: 'locked');
      final value = await _channel.invokeMethod<Object?>('createBackup', {
        'recoveryKey': recoveryKey,
      });
      if (generation != _generation || _disposed) return;
      envelope = _encryptedEnvelope(value);
    }, backup: true);
    return accepted ? envelope : null;
  }

  Future<BackupPreview?> inspectBackup(
    String envelope,
    String recoveryKey,
  ) async {
    BackupPreview? preview;
    final accepted = await _perform((generation) async {
      if (!unlocked) throw PlatformException(code: 'locked');
      final value = await _channel.invokeMapMethod<Object?, Object?>(
        'inspectBackup',
        {'envelope': envelope, 'recoveryKey': recoveryKey},
      );
      if (generation != _generation || _disposed) return;
      if (value == null) throw const FormatException('Ungültige Vorschau.');
      preview = BackupPreview.fromMap(value);
    }, backup: true);
    return accepted ? preview : null;
  }

  Future<bool> restoreBackup(
    String envelope,
    String recoveryKey,
    BackupPreview preview, {
    bool replaceExisting = false,
  }) => _perform((generation) async {
    if (!unlocked) throw PlatformException(code: 'locked');
    final values = await _channel.invokeListMethod<Object?>('restoreBackup', {
      'envelope': envelope,
      'recoveryKey': recoveryKey,
      'vaultFingerprint': preview.vaultFingerprint,
      'archiveFingerprint': preview.archiveFingerprint,
      'replaceExisting': replaceExisting,
    });
    if (generation != _generation || _disposed) return;
    _entries = _parseEntries(values);
    clearBackupSelection();
    await _refreshFormData(generation);
    if (generation != _generation || _disposed) return;
    backupNotice = 'Sicherung wiederhergestellt.';
  }, backup: true);

  String _encryptedEnvelope(Object? value) {
    if (value is! String || value.isEmpty) {
      throw const FormatException('Ungültige Sicherung.');
    }
    if (value.length > 24 * 1024 * 1024) {
      throw PlatformException(code: 'too_large');
    }
    return value;
  }

  Future<bool?> saveBackupFile(String envelope) async =>
      await _pickBackup(saveEnvelope: envelope) as bool?;

  Future<String?> loadBackupFile() async => await _pickBackup() as String?;

  Future<Object?> _pickBackup({String? saveEnvelope}) async {
    if (busy || _disposed || !unlocked) return null;
    busy = true;
    error = null;
    backupNotice = null;
    if (saveEnvelope == null) clearBackupSelection();
    _notify();
    try {
      // Pickers may background the app. Only ciphertext crosses this lock.
      await lock();
      if (_disposed) return null;
      final value = await _channel
          .invokeMethod<Object?>(
            saveEnvelope == null ? 'loadBackupFile' : 'saveBackupFile',
            saveEnvelope == null ? null : {'envelope': saveEnvelope},
          )
          .timeout(const Duration(seconds: 125));
      if (_disposed) return null;
      if (saveEnvelope != null) {
        if (value is! bool) throw const FormatException('Ungültige Antwort.');
        backupNotice = value
            ? 'Verschlüsselte Sicherung gespeichert.'
            : 'Speichern abgebrochen.';
        return value;
      }
      if (value == null) {
        backupNotice = 'Dateiauswahl abgebrochen.';
        return null;
      }
      _selectedBackup = _encryptedEnvelope(value);
      _archiveExpiry?.cancel();
      _archiveExpiry = Timer(const Duration(minutes: 5), () {
        _selectedBackup = null;
        backupNotice =
            'Dateiauswahl abgelaufen. Bitte die Sicherung neu wählen.';
        _notify();
      });
      backupNotice = 'Verschlüsselte Sicherung ausgewählt. Bitte den Tresor erneut entsperren.';
      return _selectedBackup;
    } on PlatformException catch (failure) {
      if (!_disposed) {
        error = switch (failure.code) {
          'cancelled' => 'Dateiauswahl abgebrochen.',
          'too_large' =>
            'Sicherung überschreitet die Speichergrenze von 24 MiB.',
          'backup_busy' => 'Eine Dateiauswahl läuft bereits. Bitte warten.',
          _ => 'Sicherungsdatei konnte nicht verarbeitet werden.',
        };
      }
    } on MissingPluginException {
      if (!_disposed) {
        error = 'Diese Funktion benötigt die native Android- oder iOS-App.';
      }
    } on FormatException {
      if (!_disposed) error = 'Sicherungsdatei ist ungültig.';
    } on TimeoutException {
      if (!_disposed) {
        error = 'Dateiauswahl hat zu lange gedauert. Bitte erneut versuchen.';
      }
    } finally {
      busy = false;
      _notify();
    }
    return null;
  }

  void clearBackupSelection() {
    _archiveExpiry?.cancel();
    _selectedBackup = null;
    _notify();
  }

  Future<void> lock({bool keepError = false}) async {
    _generation++;
    _expiry?.cancel();
    _entries = [];
    _profiles = [];
    appBindings = [];
    connection = {};
    websitePasskeys = [];
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
    _archiveExpiry?.cancel();
    _selectedBackup = null;
    backupNotice = null;
    _entries = [];
    _profiles = [];
    appBindings = [];
    websitePasskeys = [];
    super.dispose();
  }
}
