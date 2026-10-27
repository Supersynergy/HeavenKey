import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:heavenkey_mobile/form_profile.dart';
import 'package:heavenkey_mobile/form_profiles_panel.dart';
import 'package:heavenkey_mobile/passphrase.dart';
import 'package:heavenkey_mobile/vault_controller.dart';

Map<String, String> profile({String city = 'Berlin'}) => {
  for (final name in FormProfile.limits.keys) name: '',
  'id': 'synthetic-profile',
  'label': 'Synthetic only',
  'givenName': 'Synthetisch',
  'city': city,
  'country': 'DE',
  'updatedAt': '2026-10-27T12:00:00Z',
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('heavenkey/vault');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('complete EFF catalog and six/eight independent words, no ambiguous delimiter', () async {
    final source = File('assets/eff_large_wordlist.txt').readAsStringSync();
    final words = parseWordlist(source);
    expect(words.length, 7776);
    expect(words.toSet().length, 7776);
    for (final count in [6, 8]) {
      for (var attempt = 0; attempt < 8; attempt++) {
        final phrase = await generatePassphrase(count);
        final match = RegExp(r'^([A-Za-z.-]+)-[0-9]!$').firstMatch(phrase)!;
        final chosen = match.group(1)!.split('.');
        expect(chosen.length, count);
        expect(
          chosen.every((word) => words.contains(word.toLowerCase())),
          isTrue,
        );
        expect(chosen.first[0], chosen.first[0].toUpperCase());
      }
    }
    expect(() => generatePassphrase(3), throwsArgumentError);
    expect(() => parseWordlist('11111 short'), throwsFormatException);
    expect(
      () => parseWordlist(source.replaceFirst('abacus', 'drop-down')),
      throwsFormatException,
    );
  });

  test('profiles reject unknown fields, controls, invalid country and oversized data', () {
    expect(FormProfile.fromMap(profile()).values['city'], 'Berlin');
    for (final invalid in [
      {...profile(), 'country': 'de'},
      {...profile(), 'email': 'a\nb'},
      {...profile(), 'extra': 'secret'},
      {...profile(), 'label': ''},
      {...profile(), 'postalCode': 'x' * 33},
      {...profile(), 'updatedAt': 'invalid'},
    ]) {
      expect(() => FormProfile.fromMap(invalid), throwsFormatException);
    }
  });

  test(
    'profile CRUD and app revocation use native storage and clear on lock',
    () async {
      var stored = [profile()];
      var bindings = <Map<String, String>>[
        {
          'entryId': 'login1',
          'packageName': 'app.example.client',
          'certificates': 'a' * 64,
        },
      ];
      messenger.setMockMethodCallHandler(channel, (call) async {
        switch (call.method) {
          case 'status':
            return {'formsSupported': true};
          case 'unlock':
            return <Object?>[];
          case 'formData':
            return {'profiles': stored, 'appBindings': bindings};
          case 'saveProfile':
            stored = [Map<String, String>.from(call.arguments as Map)];
            return null;
          case 'deleteProfile':
            stored = [];
            return null;
          case 'revokeApp':
            bindings = [];
            return null;
          default:
            return null;
        }
      });
      final vault = VaultController();
      await vault.refreshStatus();
      expect(await vault.unlock(), isTrue);
      expect(vault.profiles.single.label, 'Synthetic only');
      expect(
        await vault.saveProfile(FormProfile(profile(city: 'Hamburg'))),
        isTrue,
      );
      expect(vault.profiles.single.values['city'], 'Hamburg');
      expect(vault.status['hasVault'], isTrue);
      expect(await vault.revokeApp('app.example.client'), isTrue);
      expect(vault.appBindings, isEmpty);
      expect(await vault.deleteProfile('synthetic-profile'), isTrue);
      expect(vault.profiles, isEmpty);
      await vault.saveProfile(FormProfile(profile()));
      await vault.lock();
      expect(vault.profiles, isEmpty);
      expect(vault.appBindings, isEmpty);
      expect(await vault.saveProfile(FormProfile(profile())), isFalse);
      vault.dispose();
    },
  );

  test(
    'late form response cannot unlock or repopulate a background-locked vault',
    () async {
      final delayed = Completer<Map<String, Object?>>();
      messenger.setMockMethodCallHandler(
        channel,
        (call) async => switch (call.method) {
          'status' => {'formsSupported': true},
          'unlock' => <Object?>[],
          'formData' => delayed.future,
          _ => null,
        },
      );
      final vault = VaultController();
      await vault.refreshStatus();
      final unlocking = vault.unlock();
      await Future<void>.delayed(Duration.zero);
      await vault.lock();
      delayed.complete({
        'profiles': [profile()],
        'appBindings': <Object?>[],
      });
      expect(await unlocking, isFalse);
      expect(vault.unlocked, isFalse);
      expect(vault.profiles, isEmpty);
      vault.dispose();
    },
  );

  testWidgets('profile editor saves without desktop and derives full name', (
    tester,
  ) async {
    var stored = <Map<String, String>>[];
    final calls = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return switch (call.method) {
        'status' => {'formsSupported': true},
        'unlock' => <Object?>[],
        'formData' => {'profiles': stored, 'appBindings': <Object?>[]},
        'saveProfile' => () {
          stored = [Map<String, String>.from(call.arguments as Map)];
          return null;
        }(),
        _ => null,
      };
    });
    final vault = VaultController();
    await vault.refreshStatus();
    await vault.unlock();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(children: [FormProfilesPanel(vault: vault)]),
        ),
      ),
    );
    await tester.tap(find.text('Formularprofil hinzufügen'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('profile-label')),
      'Privat',
    );
    await tester.enterText(
      find.byKey(const ValueKey('profile-givenName')),
      'Synthetisch',
    );
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Profil speichern'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Profil speichern'));
    await tester.pumpAndSettle();
    expect(stored.single['fullName'], 'Synthetisch');
    expect(find.text('Privat'), findsOneWidget);
    expect(calls, isNot(contains('connectDesktop')));
    await tester.pumpWidget(const SizedBox());
    await vault.lock();
    vault.dispose();
  });
}
