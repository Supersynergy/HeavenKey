import 'dart:async';
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
    'actual Android Keystore CRUD, fresh nonce, device auth and background lock',
    (tester) async {
      final vault = VaultController();
      const channel = MethodChannel('heavenkey/vault');
      final file = File(
        '/data/user/0/app.heavenkey.heavenkey_mobile/no_backup/heavenkey-v1.aesgcm',
      );
      final item = VaultEntry(
        id: 'native-integration-fixture',
        title: 'Native test fixture',
        origin: 'https://example.com',
        username: 'synthetic@example.test',
        password: 'Synthetic-native-test-only-24',
        updatedAt: DateTime.now().toUtc().toIso8601String(),
      );
      await tester.pumpWidget(HeavenKeyApp(controller: vault));
      Future<void> authenticate() async {
        debugPrint('NATIVE_PHASE_AUTH');
        expect(await vault.unlock(), isTrue);
      }

      try {
        await authenticate();
        expect(await vault.save(item), isTrue);
        final first =
            jsonDecode(await file.readAsString()) as Map<String, dynamic>;
        expect(first['version'], 1);
        expect(base64Decode(first['iv'] as String).length, 12);
        expect(await file.readAsString(), isNot(contains(item.password)));
        expect(await vault.save(item), isTrue);
        final second =
            jsonDecode(await file.readAsString()) as Map<String, dynamic>;
        expect(second['iv'], isNot(first['iv']));
        await vault.lock();
        expect(vault.entries, isEmpty);
        await authenticate();
        expect(
          vault.entries.singleWhere((entry) => entry.id == item.id).password,
          item.password,
        );
        expect(await vault.delete(item.id), isTrue);
        expect(vault.entries.any((entry) => entry.id == item.id), isFalse);
        final background = Completer<void>();
        void onLock() {
          if (!vault.unlocked && !background.isCompleted) background.complete();
        }

        vault.addListener(onLock);
        debugPrint('NATIVE_PHASE_BACKGROUND');
        await background.future.timeout(const Duration(seconds: 20));
        vault.removeListener(onLock);
        await Future<void>.delayed(const Duration(seconds: 2));
        expect(vault.unlocked, isFalse);
        await expectLater(
          channel.invokeMethod<void>('save', item.toMap()),
          throwsA(
            isA<PlatformException>().having(
              (error) => error.code,
              'code',
              'locked',
            ),
          ),
        );
        debugPrint(
          'NATIVE_ACCEPTANCE_OK: device authentication, encrypted save, fresh IV, native reopen, delete, background lock, native locked-write rejection',
        );
      } finally {
        await vault.lock();
        await tester.pumpWidget(const SizedBox());
        vault.dispose();
      }
    },
    skip: !Platform.isAndroid,
  );
}
