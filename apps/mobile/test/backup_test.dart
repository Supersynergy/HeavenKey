import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:heavenkey_mobile/backup_panel.dart';
import 'package:heavenkey_mobile/backup_preview.dart';
import 'package:heavenkey_mobile/main.dart';
import 'package:heavenkey_mobile/vault_controller.dart';
import 'package:heavenkey_mobile/vault_entry.dart';

const recoveryKey = 'hk1_synthetic_recovery_key_not_for_real_data';
const envelope = 'synthetic-ciphertext-envelope';

VaultEntry login(String id) => VaultEntry(
  id: id,
  title: id == 'existing' ? 'Existing login' : 'Imported login',
  origin: 'https://example.test',
  username: 'synthetic@example.test',
  password: 'synthetic-test-password-only',
  updatedAt: '2026-10-24T12:00:00.000Z',
);

Map<String, Object?> previewMap() => {
  'total': 2,
  'new': 1,
  'existing': 1,
  'vaultFingerprint': 'a' * 64,
  'archiveFingerprint': 'b' * 64,
  'entries': [
    for (final id in ['existing', 'imported'])
      {
        'id': id,
        'title': login(id).title,
        'origin': login(id).origin,
        'username': login(id).username,
      },
  ],
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('heavenkey/vault');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  Object? defaultReply(MethodCall call) => switch (call.method) {
    'status' => {'available': true, 'secureDevice': true},
    'unlock' => [login('existing').toMap()],
    'newBackupKey' => recoveryKey,
    'createBackup' || 'loadBackupFile' => envelope,
    'saveBackupFile' => true,
    'inspectBackup' => previewMap(),
    'restoreBackup' => [login('existing').toMap(), login('imported').toMap()],
    _ => null,
  };

  Future<void> selectArchive(VaultController vault) async {
    expect(await vault.unlock(), isTrue);
    expect(await vault.loadBackupFile(), envelope);
    expect(vault.unlocked, isFalse);
    expect(await vault.unlock(), isTrue);
  }

  Future<void> showBackup(WidgetTester tester, VaultController vault) async {
    await tester.pumpWidget(HeavenKeyApp(controller: vault));
    await tester.tap(find.text('Tresor entsperren'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sicherung'));
    await tester.pumpAndSettle();
  }

  Future<void> reveal(WidgetTester tester, Finder finder) async {
    if (finder.evaluate().isEmpty) {
      await tester.scrollUntilVisible(
        finder,
        180,
        scrollable: find.byType(Scrollable).first,
      );
    } else {
      await tester.ensureVisible(finder);
    }
    await tester.pumpAndSettle();
  }

  Future<void> tapVisible(WidgetTester tester, Finder finder) async {
    await reveal(tester, finder);
    await tester.tap(finder);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  tearDown(() {
    messenger.setMockMethodCallHandler(channel, null);
  });

  test('preview accepts metadata only and rejects inconsistent archives', () {
    final preview = BackupPreview.fromMap(previewMap());
    expect(preview.entries.map((value) => value.id), ['existing', 'imported']);
    expect(preview.newCount, 1);
    final invalid = [
      {...previewMap(), 'total': 501},
      {...previewMap(), 'new': 2},
      {...previewMap(), 'vaultFingerprint': 'A' * 64},
      {...previewMap(), 'archiveFingerprint': 'short'},
      {
        ...previewMap(),
        'entries': [
          for (var i = 0; i < 2; i++)
            {
              'id': 'duplicate',
              'title': 'Synthetic',
              'origin': 'https://example.test',
              'username': 'synthetic',
            },
        ],
      },
      {
        ...previewMap(),
        'entries': [
          for (final id in ['existing', 'imported']) login(id).toMap(),
        ],
      },
    ];
    for (final value in invalid) {
      expect(() => BackupPreview.fromMap(value), throwsFormatException);
    }
  });

  test(
    'wrong key and stale restore preserve the current unlocked vault',
    () async {
      var failInspect = true;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'inspectBackup' && failInspect) {
          throw PlatformException(
            code: 'invalid_key',
            message: 'PRIVATE-DETAIL',
          );
        }
        if (call.method == 'restoreBackup') {
          throw PlatformException(
            code: 'vault_changed',
            message: 'PRIVATE-DETAIL',
          );
        }
        return defaultReply(call);
      });
      final vault = VaultController();
      await vault.unlock();
      expect(await vault.inspectBackup(envelope, recoveryKey), isNull);
      expect(vault.unlocked, isTrue);
      expect(vault.entries.single.id, 'existing');
      expect(vault.error, isNot(contains('PRIVATE-DETAIL')));
      failInspect = false;
      final preview = await vault.inspectBackup(envelope, recoveryKey);
      expect(
        await vault.restoreBackup(envelope, recoveryKey, preview!),
        isFalse,
      );
      expect(vault.unlocked, isTrue);
      expect(vault.entries.single.id, 'existing');
      expect(vault.error, contains('Vorschau neu laden'));
      expect(vault.error, isNot(contains('PRIVATE-DETAIL')));
      vault.dispose();
    },
  );

  for (final method in [
    'newBackupKey',
    'createBackup',
    'inspectBackup',
    'restoreBackup',
  ]) {
    test('lock fences a delayed $method response', () async {
      final pending = Completer<Object?>();
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == method) return pending.future;
        return defaultReply(call);
      });
      final vault = VaultController();
      await vault.unlock();
      final preview = BackupPreview.fromMap(previewMap());
      final Future<Object?> action = switch (method) {
        'newBackupKey' => vault.newBackupKey(),
        'createBackup' => vault.createBackup(recoveryKey),
        'inspectBackup' => vault.inspectBackup(envelope, recoveryKey),
        _ => vault.restoreBackup(envelope, recoveryKey, preview),
      };
      await Future<void>.delayed(Duration.zero);
      await vault.lock();
      pending.complete(defaultReply(MethodCall(method)));
      expect(await action, method == 'restoreBackup' ? isFalse : isNull);
      expect(vault.unlocked, isFalse);
      expect(vault.entries, isEmpty);
      vault.dispose();
    });
  }

  test(
    'restore binds both fingerprints and preserves conflicts by default',
    () async {
      final restores = <Map<Object?, Object?>>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'restoreBackup') {
          restores.add(Map<Object?, Object?>.from(call.arguments as Map));
        }
        return defaultReply(call);
      });
      final vault = VaultController();
      await vault.unlock();
      final preview = await vault.inspectBackup(envelope, recoveryKey);
      expect(
        await vault.restoreBackup(envelope, recoveryKey, preview!),
        isTrue,
      );
      expect(restores.single, {
        'envelope': envelope,
        'recoveryKey': recoveryKey,
        'vaultFingerprint': 'a' * 64,
        'archiveFingerprint': 'b' * 64,
        'replaceExisting': false,
      });
      expect(vault.entries.length, 2);
      expect(
        await vault.restoreBackup(
          envelope,
          recoveryKey,
          preview,
          replaceExisting: true,
        ),
        isTrue,
      );
      expect(restores.last['replaceExisting'], isTrue);
      vault.dispose();
    },
  );

  test(
    'export picker receives ciphertext after native lock and never unlocks',
    () async {
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return defaultReply(call);
      });
      final vault = VaultController();
      await vault.unlock();
      final encrypted = await vault.createBackup(recoveryKey);
      expect(await vault.saveBackupFile(encrypted!), isTrue);
      expect(calls.map((call) => call.method), [
        'unlock',
        'createBackup',
        'lock',
        'saveBackupFile',
      ]);
      expect(calls.last.arguments, {'envelope': envelope});
      expect(vault.unlocked, isFalse);
      expect(vault.entries, isEmpty);
      expect(vault.backupNotice, contains('gespeichert'));
      vault.dispose();
    },
  );

  testWidgets('picker retains one encrypted archive for at most five minutes', (
    tester,
  ) async {
    final pending = Completer<Object?>();
    var loads = 0;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'loadBackupFile') {
        loads++;
        return pending.future;
      }
      return defaultReply(call);
    });
    final vault = VaultController();
    final opening = vault.unlock();
    await tester.pump();
    expect(await opening, isTrue);
    final choosing = vault.loadBackupFile();
    await tester.pump();
    expect(vault.unlocked, isFalse);
    expect(vault.entries, isEmpty);
    expect(await vault.loadBackupFile(), isNull);
    expect(await vault.unlock(), isFalse);
    expect(loads, 1);
    pending.complete(envelope);
    await tester.pump();
    expect(await choosing, envelope);
    await vault.lock();
    expect(vault.selectedBackup, envelope);
    await tester.pump(const Duration(minutes: 5));
    expect(vault.selectedBackup, isNull);
    expect(vault.backupNotice, contains('abgelaufen'));
    vault.dispose();
  });

  testWidgets(
    'export requires separate key storage and clears its key on lock',
    (tester) async {
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return defaultReply(call);
      });
      final vault = VaultController();
      await showBackup(tester, vault);
      await tapVisible(tester, find.text('Schlüssel erzeugen'));
      expect(find.text(recoveryKey), findsOneWidget);
      final exportButton = find.widgetWithText(
        FilledButton,
        'Verschlüsselte Datei speichern',
      );
      expect(tester.widget<FilledButton>(exportButton).onPressed, isNull);
      await tapVisible(tester, find.text('Schlüssel geschützt kopieren'));
      expect(calls.last.method, 'copyBackupKey');
      expect(calls.last.arguments, {'recoveryKey': recoveryKey});
      await tapVisible(tester, find.byType(CheckboxListTile));
      expect(tester.widget<FilledButton>(exportButton).onPressed, isNotNull);
      await tapVisible(tester, exportButton);
      expect(vault.unlocked, isFalse);
      expect(find.text(recoveryKey), findsNothing);
      expect(find.text('Tresor entsperren'), findsOneWidget);
      await tester.tap(find.text('Tresor entsperren'));
      await tester.pumpAndSettle();
      expect(find.text(recoveryKey), findsNothing);
      expect(find.text('Schlüssel erzeugen'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      vault.dispose();
    },
  );

  testWidgets(
    'backgrounded file picker needs unlock and fences a stale preview',
    (tester) async {
      final file = Completer<Object?>();
      final inspection = Completer<Object?>();
      var unlocks = 0;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'unlock') unlocks++;
        if (call.method == 'loadBackupFile') return file.future;
        if (call.method == 'inspectBackup') return inspection.future;
        return defaultReply(call);
      });
      final vault = VaultController();
      await showBackup(tester, vault);
      await tapVisible(tester, find.text('Sicherungsdatei auswählen'));
      for (final state in [
        AppLifecycleState.inactive,
        AppLifecycleState.hidden,
        AppLifecycleState.paused,
      ]) {
        tester.binding.handleAppLifecycleStateChanged(state);
      }
      await tester.pumpAndSettle();
      file.complete(envelope);
      await tester.pumpAndSettle();
      expect(vault.selectedBackup, envelope);
      expect(vault.unlocked, isFalse);
      expect(vault.entries, isEmpty);
      expect(unlocks, 1);
      for (final state in [
        AppLifecycleState.hidden,
        AppLifecycleState.inactive,
        AppLifecycleState.resumed,
      ]) {
        tester.binding.handleAppLifecycleStateChanged(state);
      }
      await tester.pumpAndSettle();
      await tester.tap(find.text('Tresor entsperren'));
      await tester.pumpAndSettle();
      final keyField = find.widgetWithText(
        TextField,
        'Wiederherstellungsschlüssel',
      );
      await reveal(tester, keyField);
      await tester.enterText(keyField, recoveryKey);
      await tapVisible(tester, find.text('Vorschau prüfen'));
      await vault.lock();
      await tester.pump();
      inspection.complete(previewMap());
      await tester.pumpAndSettle();
      expect(find.text('2 Logins: 1 neu, 1 bereits vorhanden.'), findsNothing);
      expect(find.byType(TextField), findsNothing);
      await tester.tap(find.text('Tresor entsperren'));
      await tester.pumpAndSettle();
      expect(find.text('2 Logins: 1 neu, 1 bereits vorhanden.'), findsNothing);
      await reveal(tester, keyField);
      final restoredField = tester.widget<TextField>(
        find.widgetWithText(TextField, 'Wiederherstellungsschlüssel'),
      );
      expect(restoredField.controller!.text, isEmpty);
      expect(restoredField.obscureText, isTrue);
      expect(restoredField.enableSuggestions, isFalse);
      expect(restoredField.enableIMEPersonalizedLearning, isFalse);
      await tester.pumpWidget(const SizedBox());
      vault.dispose();
    },
  );

  testWidgets('editing the key invalidates an in-flight preview', (
    tester,
  ) async {
    final pending = Completer<Object?>();
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'inspectBackup') return pending.future;
      return defaultReply(call);
    });
    final vault = VaultController();
    await selectArchive(vault);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: BackupPanel(vault: vault)),
      ),
    );
    final field = find.widgetWithText(TextField, 'Wiederherstellungsschlüssel');
    await reveal(tester, field);
    await tester.enterText(field, recoveryKey);
    await tapVisible(tester, find.text('Vorschau prüfen'));
    await tester.enterText(field, '${recoveryKey}_changed');
    pending.complete(previewMap());
    await tester.pumpAndSettle();
    expect(find.text('2 Logins: 1 neu, 1 bereits vorhanden.'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    vault.dispose();
  });

  for (final replaceExisting in [false, true]) {
    testWidgets(
      'restore needs confirmation and uses replacement=$replaceExisting',
      (tester) async {
        Map<Object?, Object?>? restore;
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'restoreBackup') {
            restore = Map<Object?, Object?>.from(call.arguments as Map);
          }
          return defaultReply(call);
        });
        final vault = VaultController();
        await selectArchive(vault);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: BackupPanel(vault: vault)),
          ),
        );
        final field = find.widgetWithText(
          TextField,
          'Wiederherstellungsschlüssel',
        );
        await reveal(tester, field);
        await tester.enterText(field, recoveryKey);
        await tapVisible(tester, find.text('Vorschau prüfen'));
        expect(
          find.text('2 Logins: 1 neu, 1 bereits vorhanden.'),
          findsOneWidget,
        );
        final conflict = find.widgetWithText(
          CheckboxListTile,
          'Vorhandene Logins und Profile mit gleicher ID ersetzen',
        );
        await reveal(tester, conflict);
        expect(tester.widget<CheckboxListTile>(conflict).value, isFalse);
        if (replaceExisting) await tapVisible(tester, conflict);
        await tapVisible(tester, find.text('Wiederherstellung vorbereiten'));
        expect(restore, isNull);
        await tapVisible(tester, find.text('Wiederherstellung bestätigen'));
        expect(restore!['replaceExisting'], replaceExisting);
        expect(vault.entries.length, 2);
        expect(vault.selectedBackup, isNull);
        expect(
          find.widgetWithText(TextField, 'Wiederherstellungsschlüssel'),
          findsNothing,
        );
        await tester.pumpWidget(const SizedBox());
        vault.dispose();
      },
    );
  }
}
