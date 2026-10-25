import 'dart:convert';
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
    'actual paired desktop TLS sync, passkeys, deletion and conflict consent',
    (tester) async {
      final vault = VaultController();
      const directory = '/data/user/0/app.heavenkey.heavenkey_mobile/files';
      Future<void> authenticate() async {
        debugPrint('NATIVE_PHASE_AUTH');
        expect(await vault.unlock(), isTrue);
      }

      Future<void> phase(String name) async {
        debugPrint(name);
        final deadline = DateTime.now().add(const Duration(seconds: 45));
        final ack = File('$directory/heavenkey-test-sync-ack');
        while (DateTime.now().isBefore(deadline)) {
          if (await ack.exists() && (await ack.readAsString()).trim() == name) {
            return;
          }
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        fail('Desktop fixture did not acknowledge $name');
      }

      VaultEntry change(VaultEntry entry, {String? password}) => VaultEntry(
        id: entry.id,
        title: entry.title,
        origin: entry.origin,
        username: entry.username,
        password: password ?? entry.password,
        notes: entry.notes,
        updatedAt: DateTime.now().toUtc().toIso8601String(),
      );
      VaultEntry item(String title) =>
          vault.entries.singleWhere((entry) => entry.title == title);
      await tester.pumpWidget(HeavenKeyApp(controller: vault));
      try {
        await authenticate();
        await vault.disconnectDesktop();
        for (final entry in vault.entries.toList()) {
          if (const {
            'Desktop sync fixture',
            'Desktop delete probe',
            'Conflict fixture',
          }.contains(entry.title)) {
            expect(await vault.delete(entry.id), isTrue);
          }
        }
        await phase('SYNC_PHASE_PAIR');
        final code = (await File(
          '$directory/heavenkey-test-pair.code',
        ).readAsString()).trim();
        final pairing = jsonDecode(
          utf8.decode(base64Url.decode(base64Url.normalize(code.substring(5)))),
        ) as Map<String, dynamic>;
        final wrong = Map<String, dynamic>.of(pairing)
          ..['certificate_sha256'] = List.filled(43, 'A').join();
        final wrongCode =
            'hks1_${base64Url.encode(utf8.encode(jsonEncode(wrong))).replaceAll('=', '')}';
        final before = vault.entries.map((entry) => entry.toMap()).toList();
        expect(await vault.synchronize(code: wrongCode), isFalse);
        expect(vault.error, contains('Zertifikat'));
        expect(vault.entries.map((entry) => entry.toMap()).toList(), before);
        expect(await vault.disconnectDesktop(), isTrue);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Geräte'));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.widgetWithText(TextField, 'Einmaliger Kopplungscode'),
          code,
        );
        await tester.tap(find.text('Desktop koppeln und synchronisieren'));
        await tester.pump();
        final end = DateTime.now().add(const Duration(seconds: 25));
        while (DateTime.now().isBefore(end) &&
            (vault.busy || vault.connection['connected'] != true)) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
          await tester.pump();
        }
        expect(vault.error, isNull);
        expect(vault.connection['connected'], isTrue);
        expect(item('Desktop sync fixture').origin, 'https://example.test');
        expect(
          vault.websitePasskeys.any((key) => key['rpId'] == 'heavenkey.test'),
          isTrue,
        );
        expect(
          await vault.save(
            change(
              item('Desktop sync fixture'),
              password: 'Synthetic-Native-Changed-25',
            ),
          ),
          isTrue,
        );
        expect(await vault.synchronize(), isTrue);
        await phase('SYNC_PHASE_DESKTOP_RECEIVE');
        await phase('SYNC_PHASE_DESKTOP_EDIT');
        await authenticate();
        expect(await vault.synchronize(), isTrue);
        expect(item('Desktop sync fixture').notes, 'Desktop changed note');
        expect(await vault.delete(item('Desktop sync fixture').id), isTrue);
        expect(await vault.synchronize(), isTrue);
        await phase('SYNC_PHASE_VERIFY_DELETED');
        expect(await vault.synchronize(), isTrue);
        expect(item('Desktop delete probe').title, 'Desktop delete probe');
        await phase('SYNC_PHASE_DELETE_PROBE');
        expect(await vault.synchronize(), isTrue);
        expect(
          vault.entries.any((entry) => entry.title == 'Desktop delete probe'),
          isFalse,
        );
        await phase('SYNC_PHASE_CONFLICT_SEED');
        await authenticate();
        expect(await vault.synchronize(), isTrue);
        expect(
          await vault.save(
            change(
              item('Conflict fixture'),
              password: 'Synthetic-Native-Conflict-25',
            ),
          ),
          isTrue,
        );
        await phase('SYNC_PHASE_CONFLICT_EDIT');
        expect(await vault.synchronize(), isFalse);
        expect(vault.error, contains('konflikt'));
        expect(
          item('Conflict fixture').password,
          'Synthetic-Native-Conflict-25',
        );
        await vault.refreshConnections();
        final proposal = vault.connection['conflict'] as Map;
        final oldToken = proposal['token'] as String;
        await phase('SYNC_PHASE_CONFLICT_ADVANCE');
        expect(
          await vault.synchronize(
            resolution: 'remote',
            conflictToken: oldToken,
          ),
          isFalse,
        );
        expect(vault.error, contains('geändert'));
        expect(
          item('Conflict fixture').password,
          'Synthetic-Native-Conflict-25',
        );
        await vault.refreshConnections();
        final current = vault.connection['conflict'] as Map;
        expect(
          await vault.synchronize(
            resolution: 'remote',
            conflictToken: '${current['token']}',
          ),
          isTrue,
        );
        expect(
          item('Conflict fixture').password,
          'Synthetic-Desktop-Conflict-25',
        );
        await phase('SYNC_PHASE_VERIFY_RESOLUTION');
        await phase('SYNC_PHASE_REVOKE');
        final intact = vault.entries.map((entry) => entry.toMap()).toList();
        expect(await vault.synchronize(), isFalse);
        expect(vault.error, contains('widerrufen'));
        expect(vault.entries.map((entry) => entry.toMap()).toList(), intact);
        debugPrint('SYNC_NATIVE_OK');
      } finally {
        await vault.lock();
        await tester.pumpWidget(const SizedBox());
        vault.dispose();
      }
    },
    skip: !Platform.isAndroid,
    timeout: const Timeout(Duration(minutes: 7)),
  );
}
