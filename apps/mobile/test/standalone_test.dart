import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:heavenkey_mobile/backup_preview.dart';
import 'package:heavenkey_mobile/main.dart';
import 'package:heavenkey_mobile/vault_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('heavenkey/vault');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final calls = <String>[];
  var stored = <Map<String, String>>[];
  var secure = true;
  var passkeysSupported = true;

  setUp(() {
    calls.clear();
    stored = [];
    secure = true;
    passkeysSupported = true;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return switch (call.method) {
        'status' => {
          'available': true,
          'secureDevice': secure,
          'hasVault': stored.isNotEmpty,
          'platform': 'android',
          'passkeysSupported': passkeysSupported,
          'backupIncludesPasskeys': true,
        },
        'unlock' => stored,
        'save' => () {
          stored = [Map<String, String>.from(call.arguments as Map)];
          return null;
        }(),
        'connectedStatus' => {'connected': false, 'passkeys': <Object?>[]},
        _ => null,
      };
    });
  });
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  Future<void> tapVisible(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pumpAndSettle();
    await tester.tap(finder);
    await tester.pumpAndSettle();
  }

  testWidgets('first Android login works without master password or desktop', (
    tester,
  ) async {
    final vault = VaultController();
    await tester.pumpWidget(HeavenKeyApp(controller: vault));
    await tester.pumpAndSettle();
    await tapVisible(tester, find.text('Auf diesem Handy starten'));
    await tapVisible(tester, find.text('Ersten Login speichern'));
    expect(find.byType(TextFormField), findsNWidgets(3));
    await tester.enterText(
      find.widgetWithText(TextFormField, 'HTTPS-Website'),
      'example.test',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Benutzername oder E-Mail'),
      'synthetic@example.test',
    );
    await tapVisible(tester, find.text('32 Zeichen'));
    await tapVisible(tester, find.text('Zufälliges Passwort erzeugen'));
    await tapVisible(tester, find.text('Login speichern'));
    expect(stored.single['password'], hasLength(32));
    expect(stored.single['title'], 'example.test');
    expect(calls, isNot(contains('connectDesktop')));
    expect(calls, isNot(contains('copyPassword')));
    await vault.lock();
    await tester.pumpAndSettle();
    await tapVisible(tester, find.text('Tresor entsperren'));
    expect(find.text('example.test'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    vault.dispose();
  });

  testWidgets(
    'missing screen lock has a direct setup action and blocks unlock',
    (tester) async {
      secure = false;
      final vault = VaultController();
      await tester.pumpWidget(HeavenKeyApp(controller: vault));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Auf diesem Handy starten'),
            )
            .onPressed,
        isNull,
      );
      await tapVisible(tester, find.text('Gerätesperre einrichten'));
      expect(calls, contains('configureDeviceSecurity'));
      expect(calls, isNot(contains('unlock')));
      await tester.pumpWidget(const SizedBox());
      vault.dispose();
    },
  );

  for (final supported in [false, true]) {
    testWidgets(
      'passkeys are independent of pairing; API support is $supported',
      (tester) async {
        passkeysSupported = supported;
        final vault = VaultController();
        await tester.pumpWidget(HeavenKeyApp(controller: vault));
        await tester.pumpAndSettle();
        await tapVisible(tester, find.text('Auf diesem Handy starten'));
        await tapVisible(tester, find.text('Passkeys'));
        final setup = find.widgetWithText(
          FilledButton,
          'Passkey-Anbieter einrichten',
        );
        expect(tester.widget<FilledButton>(setup).onPressed != null, supported);
        if (supported) await tapVisible(tester, setup);
        expect(calls.contains('enablePasskeys'), supported);
        expect(calls, isNot(contains('connectDesktop')));
        await tester.pumpWidget(const SizedBox());
        vault.dispose();
      },
    );
  }

  testWidgets('Android back leaves the editor inside the vault', (
    tester,
  ) async {
    final vault = VaultController();
    await tester.pumpWidget(HeavenKeyApp(controller: vault));
    await tester.pumpAndSettle();
    await tapVisible(tester, find.text('Auf diesem Handy starten'));
    await tapVisible(tester, find.text('Ersten Login speichern'));
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(EntryEditor), findsNothing);
    expect(vault.unlocked, isTrue);
    await tester.pumpWidget(const SizedBox());
    vault.dispose();
  });

  test('portable preview rejects inconsistent passkey counts', () {
    final preview = <Object?, Object?>{
      'total': 0,
      'new': 0,
      'existing': 0,
      'entries': <Object?>[],
      'vaultFingerprint': 'a' * 64,
      'archiveFingerprint': 'b' * 64,
      'passkeyCount': 2,
      'newPasskeys': 1,
      'existingPasskeys': 1,
    };
    expect(BackupPreview.fromMap(preview).newPasskeys, 1);
    expect(
      () => BackupPreview.fromMap({...preview, 'newPasskeys': 2}),
      throwsFormatException,
    );
    expect(
      () => BackupPreview.fromMap({...preview, 'passkeyCount': -1}),
      throwsFormatException,
    );
  });

  testWidgets(
    'small screen and large text keep setup and generator scrollable',
    (tester) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 1.6;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final vault = VaultController();
      await tester.pumpWidget(HeavenKeyApp(controller: vault));
      await tester.pumpAndSettle();
      await tapVisible(tester, find.text('Auf diesem Handy starten'));
      await tapVisible(tester, find.text('Ersten Login speichern'));
      await tapVisible(tester, find.text('48 Zeichen'));
      await tapVisible(tester, find.text('Zufälliges Passwort erzeugen'));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vault.dispose();
    },
  );
}
