import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:heavenkey_mobile/main.dart';
import 'package:heavenkey_mobile/vault_controller.dart';
import 'package:heavenkey_mobile/vault_entry.dart';

VaultEntry entry({
  String id = 'entry1',
  String password = 'a-secret-with-24-letters!',
}) => VaultEntry(
  id: id,
  title: 'Example',
  origin: 'https://example.com',
  username: 'synthetic@example.test',
  password: password,
  updatedAt: '2026-10-24T12:00:00.000Z',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('heavenkey/vault');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() {
    messenger.setMockMethodCallHandler(channel, null);
  });

  test('HTTPS origin preserves host and nondefault port boundaries', () {
    expect(canonicalOrigin('https://EXAMPLE.com:443/'), 'https://example.com');
    expect(
      canonicalOrigin('https://example.com:8443'),
      'https://example.com:8443',
    );
    expect(
      canonicalOrigin('https://example.com'),
      isNot(canonicalOrigin('https://login.example.com')),
    );
    expect(
      canonicalOrigin('https://example.com'),
      isNot(canonicalOrigin('https://example.com:8443')),
    );
    for (final value in [
      'http://example.com',
      'https://u:p@example.com',
      'https://example.com/a',
      'https://example.com?',
      'https://example.com#',
      'https://example.com.',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://éxample.com',
      ' https://example.com',
      'https://ex%61mple.com',
      'https://example.com:0',
      'https://example.com:65536',
    ]) {
      expect(
        () => canonicalOrigin(value),
        throwsFormatException,
        reason: value,
      );
    }
  });
  test('generator and local health enforce documented bounds', () {
    for (var i = 0; i < 32; i++) {
      final password = generatePassword();
      expect(password.length, 24);
      for (final group in [r'[A-Z]', r'[a-z]', r'[2-9]', r'[!@#%+_=?:-]']) {
        expect(RegExp(group).hasMatch(password), isTrue);
      }
    }
    expect(() => generatePassword(8), throwsRangeError);
    final values = [
      entry(password: 'short'),
      entry(id: 'entry2', password: 'short'),
    ];
    expect(passwordHealth(values), (short: 2, reused: 2));
    expect(values.first.matches('secret'), isFalse);
  });
  test('malformed records and oversized fields are rejected', () {
    expect(
      () => VaultEntry.fromMap({...entry().toMap(), 'password': 42}),
      throwsFormatException,
    );
    expect(
      () => VaultEntry.fromMap({...entry().toMap(), 'title': 'x' * 121}),
      throwsFormatException,
    );
    expect(
      () => VaultEntry.fromMap({
        ...entry().toMap(),
        'origin': 'https://example.com/',
      }),
      throwsFormatException,
    );
  });
  test(
    'CRUD persists through the platform and survives a new controller',
    () async {
      var stored = <Map<String, String>>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        switch (call.method) {
          case 'unlock':
            return stored;
          case 'save':
            stored = [Map<String, String>.from(call.arguments as Map)];
            return null;
          case 'delete':
            stored = [];
            return null;
          default:
            return null;
        }
      });
      final vault = VaultController();
      expect(await vault.save(entry()), isFalse);
      expect(await vault.unlock(), isTrue);
      expect(await vault.save(entry()), isTrue);
      await vault.lock();
      expect(vault.entries, isEmpty);
      vault.dispose();
      final reopened = VaultController();
      await reopened.unlock();
      expect(reopened.entries.single.username, 'synthetic@example.test');
      expect(await reopened.delete('entry1'), isTrue);
      expect(reopened.entries, isEmpty);
      reopened.dispose();
    },
  );
  test('lock fences a delayed authentication result', () async {
    final pending = Completer<Object?>();
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => call.method == 'unlock' ? pending.future : null,
    );
    final vault = VaultController();
    final opening = vault.unlock();
    await Future<void>.delayed(Duration.zero);
    await vault.lock();
    pending.complete([entry().toMap()]);
    expect(await opening, isFalse);
    expect(vault.unlocked, isFalse);
    expect(vault.entries, isEmpty);
    vault.dispose();
  });
  test(
    'a storage limit preserves the unlocked editor and existing entries',
    () async {
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'unlock') return [entry().toMap()];
        if (call.method == 'save') throw PlatformException(code: 'vault_full');
        return null;
      });
      final vault = VaultController();
      await vault.unlock();
      expect(await vault.save(entry(id: 'new-entry')), isFalse);
      expect(vault.unlocked, isTrue);
      expect(vault.entries.single.id, 'entry1');
      vault.dispose();
    },
  );
  test(
    'cancellation and corrupt storage fail closed without raw error text',
    () async {
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'unlock') {
          throw PlatformException(code: 'cancelled', message: 'DO-NOT-REVEAL');
        }
        return null;
      });
      final vault = VaultController();
      expect(await vault.unlock(), isFalse);
      expect(vault.unlocked, isFalse);
      expect(vault.error, isNot(contains('DO-NOT-REVEAL')));
      messenger.setMockMethodCallHandler(
        channel,
        (call) async =>
            call.method == 'unlock' ? [entry().toMap(), entry().toMap()] : null,
      );
      expect(await vault.unlock(), isFalse);
      expect(vault.entries, isEmpty);
      vault.dispose();
    },
  );
  testWidgets('session expires and removes secrets from the rendered editor', (
    tester,
  ) async {
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => switch (call.method) {
        'status' => {'available': true, 'secureDevice': true},
        'unlock' => [entry().toMap()],
        _ => null,
      },
    );
    final vault = VaultController();
    await tester.pumpWidget(HeavenKeyApp(controller: vault));
    await tester.tap(find.text('Tresor entsperren'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Example'));
    await tester.pumpAndSettle();
    expect(find.text('Login bearbeiten'), findsOneWidget);
    await tester.pump(const Duration(seconds: 61));
    await tester.pumpAndSettle();
    expect(find.text('Login bearbeiten'), findsNothing);
    expect(vault.entries, isEmpty);
    expect(find.text('Tresor entsperren'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    vault.dispose();
  });
  testWidgets('background clears credentials and the active editor', (
    tester,
  ) async {
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => call.method == 'unlock' ? [entry().toMap()] : null,
    );
    final vault = VaultController();
    await tester.pumpWidget(HeavenKeyApp(controller: vault));
    await tester.tap(find.text('Tresor entsperren'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Example'));
    await tester.pumpAndSettle();
    for (final state in [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pumpAndSettle();
    expect(vault.entries, isEmpty);
    expect(vault.unlocked, isFalse);
    for (final state in [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pumpAndSettle();
    expect(find.text('Login bearbeiten'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    vault.dispose();
  });
}
