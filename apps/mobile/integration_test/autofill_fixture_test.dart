import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:heavenkey_mobile/main.dart';
import 'package:heavenkey_mobile/vault_controller.dart';
import 'package:heavenkey_mobile/vault_entry.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'seed isolated browser fixtures through the authenticated native vault',
    (tester) async {
      final vault = VaultController();
      await tester.pumpWidget(HeavenKeyApp(controller: vault));
      try {
        await vault.refreshStatus();
        expect(vault.status['browserTrusted'], isTrue);
        debugPrint('NATIVE_PHASE_AUTH');
        expect(await vault.unlock(), isTrue);
        for (final port in ['', ':9443']) {
          expect(
            await vault.save(
              VaultEntry(
                id: port.isEmpty
                    ? 'browser-fixture-default'
                    : 'browser-fixture-port',
                title: port.isEmpty
                    ? 'Default-port synthetic'
                    : 'Custom-port synthetic',
                origin: 'https://heavenkey.test$port',
                username: port.isEmpty
                    ? 'default@example.test'
                    : 'port@example.test',
                password: 'Synthetic-autofill-only-24',
                updatedAt: DateTime.now().toUtc().toIso8601String(),
              ),
            ),
            isTrue,
          );
        }
        debugPrint('AUTOFILL_FIXTURE_OK');
      } finally {
        await vault.lock();
        await tester.pumpWidget(const SizedBox());
        vault.dispose();
      }
    },
    skip: !Platform.isAndroid,
  );
}
