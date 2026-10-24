import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:heavenkey_mobile/main.dart';
import 'package:heavenkey_mobile/vault_controller.dart';
import 'package:heavenkey_mobile/vault_entry.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native portable backup, merge guards and actual document pickers',
    (tester) async {
      final vault = VaultController();
      const channel = MethodChannel('heavenkey/vault');
      final file = File(
        '/data/user/0/app.heavenkey.heavenkey_mobile/no_backup/heavenkey-v1.aesgcm',
      );
      VaultEntry entry(String id, String password) => VaultEntry(
        id: id,
        title: 'Synthetic backup $id',
        origin: 'https://example.com:8443',
        username: 'synthetic@example.test',
        password: password,
        notes: 'Unicode: Grüße 🔑',
        updatedAt: DateTime.now().toUtc().toIso8601String(),
      );
      Future<void> authenticate() async {
        debugPrint('NATIVE_PHASE_AUTH');
        expect(await vault.unlock(), isTrue);
      }

      await tester.pumpWidget(HeavenKeyApp(controller: vault));
      try {
        await authenticate();
        final first = entry(
          'backup-native-a',
          'Synthetic-Original-Password-24',
        );
        final second = entry('backup-native-b', 'Synthetic-Second-Password-24');
        expect(await vault.save(first), isTrue);
        expect(await vault.save(second), isTrue);
        final key = (await vault.newBackupKey())!;
        expect(key, matches(RegExp(r'^hk1_[A-Za-z0-9_-]{43}$')));
        final envelope = (await vault.createBackup(key))!;
        expect(envelope, isNot(contains(first.password)));
        expect(envelope, isNot(contains(key)));
        final another = (await vault.createBackup(key))!;
        expect(
          (jsonDecode(another) as Map)['iv'],
          isNot((jsonDecode(envelope) as Map)['iv']),
        );
        final beforeErrors = await file.readAsBytes();
        final wrongKey = (await vault.newBackupKey())!;
        expect(await vault.inspectBackup(envelope, wrongKey), isNull);
        expect(vault.unlocked, isTrue);
        expect(await file.readAsBytes(), orderedEquals(beforeErrors));
        final damaged = jsonDecode(envelope) as Map<String, dynamic>;
        final encrypted = damaged['ciphertext'] as String;
        damaged['ciphertext'] =
            (encrypted[0] == 'A' ? 'B' : 'A') + encrypted.substring(1);
        expect(await vault.inspectBackup(jsonEncode(damaged), key), isNull);
        expect(await file.readAsBytes(), orderedEquals(beforeErrors));
        final stale = (await vault.inspectBackup(envelope, key))!;
        final changed = entry(first.id, 'Synthetic-Changed-Password-24');
        expect(await vault.save(changed), isTrue);
        final beforeStale = await file.readAsBytes();
        expect(await vault.restoreBackup(envelope, key, stale), isFalse);
        expect(await file.readAsBytes(), orderedEquals(beforeStale));
        expect(vault.unlocked, isTrue);
        expect(await vault.delete(second.id), isTrue);
        final merge = (await vault.inspectBackup(envelope, key))!;
        expect(await vault.restoreBackup(envelope, key, merge), isTrue);
        expect(
          vault.entries.firstWhere((e) => e.id == first.id).password,
          changed.password,
        );
        expect(
          vault.entries.firstWhere((e) => e.id == second.id).password,
          second.password,
        );
        final overwrite = (await vault.inspectBackup(envelope, key))!;
        expect(
          await vault.restoreBackup(
            envelope,
            key,
            overwrite,
            replaceExisting: true,
          ),
          isTrue,
        );
        expect(
          vault.entries.firstWhere((e) => e.id == first.id).password,
          first.password,
        );
        expect(await vault.copyBackupKey(key), isTrue);
        expect(
          (await Clipboard.getData(Clipboard.kTextPlain))?.text == key,
          isTrue,
        );
        debugPrint('BACKUP_PHASE_CLIPBOARD_BACKGROUND');
        await Future<void>.delayed(const Duration(seconds: 34));
        expect(vault.unlocked, isFalse);
        expect(
          (await Clipboard.getData(Clipboard.kTextPlain))?.text == key,
          isFalse,
        );
        await authenticate();
        expect(await vault.copyBackupKey(key), isTrue);
        await Clipboard.setData(
          const ClipboardData(text: 'Foreign-synthetic-clipboard'),
        );
        await vault.lock();
        expect(
          (await Clipboard.getData(Clipboard.kTextPlain))?.text,
          'Foreign-synthetic-clipboard',
        );

        await authenticate();
        debugPrint('BACKUP_PHASE_SAVE_FILE');
        expect(await vault.saveBackupFile(envelope), isTrue);
        expect(vault.unlocked, isFalse);
        expect(vault.entries, isEmpty);
        await authenticate();
        debugPrint('BACKUP_PHASE_LOAD_FILE');
        final loaded = await vault.loadBackupFile();
        expect(loaded, envelope);
        expect(vault.unlocked, isFalse);
        await expectLater(
          channel.invokeMethod('inspectBackup', {
            'envelope': loaded,
            'recoveryKey': key,
          }),
          throwsA(
            isA<PlatformException>().having((e) => e.code, 'code', 'locked'),
          ),
        );
        await authenticate();
        final fromFile = (await vault.inspectBackup(loaded!, key))!;
        final beforeNoop = await file.readAsBytes();
        expect(await vault.restoreBackup(loaded, key, fromFile), isTrue);
        expect(await file.readAsBytes(), orderedEquals(beforeNoop));
        debugPrint('BACKUP_PHASE_CANCEL_FILE');
        expect(await vault.loadBackupFile(), isNull);
        expect(vault.unlocked, isFalse);
        await authenticate();
        expect(await vault.delete(first.id), isTrue);
        expect(await vault.delete(second.id), isTrue);
        debugPrint('BACKUP_NATIVE_OK');
      } finally {
        await vault.lock();
        await tester.pumpWidget(const SizedBox());
        vault.dispose();
      }
    },
    skip: !Platform.isAndroid,
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
