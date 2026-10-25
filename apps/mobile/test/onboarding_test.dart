import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:heavenkey_mobile/main.dart';
import 'package:heavenkey_mobile/vault_controller.dart';
import 'package:heavenkey_mobile/vault_entry.dart';
import 'package:heavenkey_mobile/website_input.dart';

Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Finder field(String label) => find.widgetWithText(TextFormField, label);

Future<void> editor(
  WidgetTester tester, {
  required SaveEntry onSave,
  List<String> usernameHints = const [],
}) => tester.pumpWidget(
  MaterialApp(
    home: Scaffold(
      body: EntryEditor(
        busy: false,
        onSave: onSave,
        onCancel: () {},
        usernameHints: usernameHints,
      ),
    ),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('heavenkey/vault');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('form normalization retains exact HTTPS host and port boundaries', () {
    for (final value in [
      'example.com',
      'https://EXAMPLE.com/',
      ' https://example.com/login?q=%2F#top ',
    ]) {
      expect(originFromWebsiteInput(value), 'https://example.com');
    }
    expect(
      originFromWebsiteInput('login.example.com:8443/account'),
      'https://login.example.com:8443',
    );
    for (final value in [
      '',
      'http://example.com/login',
      'ftp://example.com',
      'https://user:password@example.com/login',
      'user@example.com',
      '127.0.0.1/login',
      'https://[::1]/login',
      'localhost',
      'https://example.com./',
      'https://ex%61mple.com/path',
      'https://éxample.com',
      'https://example.com:0/path',
      'https://example.com:65536/path',
      'https://example.com\\@evil.test',
      'https://example.com/has space',
    ]) {
      expect(
        () => originFromWebsiteInput(value),
        throwsFormatException,
        reason: value,
      );
    }
    expect(() => canonicalOrigin('example.com'), throwsFormatException);
    expect(
      () => canonicalOrigin('https://example.com/login'),
      throwsFormatException,
    );
  });

  testWidgets('invalid website cannot save after scrolling to submit', (
    tester,
  ) async {
    var saves = 0;
    await editor(tester, onSave: (_) async => saves++);
    await tester.enterText(field('HTTPS-Website'), 'http://example.com/login');
    await tester.enterText(field('Passwort'), 'keep-existing-password');
    await tapVisible(tester, find.text('Login speichern'));
    expect(saves, 0);
    expect(
      find.text('HTTPS-Domain eingeben, ohne Zugangsdaten oder IP-Adresse.'),
      findsOneWidget,
    );
  });

  testWidgets('username hints need selection and notes are progressive', (
    tester,
  ) async {
    VaultEntry? saved;
    await editor(
      tester,
      onSave: (value) async => saved = value,
      usernameHints: ['local@example.test'],
    );
    expect(
      tester
          .widget<TextFormField>(field('Benutzername oder E-Mail'))
          .controller!
          .text,
      isEmpty,
    );
    expect(find.byType(ActionChip), findsOneWidget);
    expect(field('Notizen'), findsNothing);
    await tapVisible(tester, find.text('local@example.test'));
    expect(
      tester
          .widget<TextFormField>(field('Benutzername oder E-Mail'))
          .controller!
          .text,
      'local@example.test',
    );
    expect(find.byType(ActionChip), findsNothing);
    await tester.enterText(
      field('Benutzername oder E-Mail'),
      'my-own-username',
    );
    await tapVisible(tester, find.text('Notiz hinzufügen'));
    await tester.enterText(field('Notizen'), 'Synthetic local note');
    await tester.ensureVisible(field('HTTPS-Website'));
    await tester.enterText(field('HTTPS-Website'), 'example.com');
    await tester.enterText(field('Passwort'), 'keep-existing-password');
    await tapVisible(tester, find.text('Login speichern'));
    expect(saved?.username, 'my-own-username');
    expect(saved?.notes, 'Synthetic local note');
  });

  testWidgets(
    'website paste previews exact origin and infers only an empty name',
    (tester) async {
      VaultEntry? saved;
      await editor(tester, onSave: (value) async => saved = value);
      await tester.enterText(
        field('HTTPS-Website'),
        'https://EXAMPLE.com:8443/login?next=%2Fhome#form',
      );
      await tester.pump();
      expect(
        find.text('Gespeichert wird: https://example.com:8443'),
        findsOneWidget,
      );
      expect(
        find.text('Pfad, Suchparameter und Fragment werden weggelassen.'),
        findsOneWidget,
      );
      await tester.enterText(field('Passwort'), 'my-existing-password');
      await tapVisible(tester, find.text('Login speichern'));
      expect(saved?.origin, 'https://example.com:8443');
      expect(saved?.title, 'example.com');
      expect(saved?.password, 'my-existing-password');
      await tapVisible(tester, find.text('Eigenen Namen vergeben'));
      await tester.ensureVisible(field('Name'));
      await tester.enterText(field('Name'), 'Mein eigener Name');
      await tester.enterText(field('HTTPS-Website'), 'login.example.org');
      await tapVisible(tester, find.text('Login speichern'));
      expect(saved?.origin, 'https://login.example.org');
      expect(saved?.title, 'Mein eigener Name');
    },
  );

  testWidgets(
    'generation never replaces entered password without confirmation',
    (tester) async {
      await editor(tester, onSave: (_) async {});
      await tester.enterText(field('Passwort'), 'keep-this-password');
      await tapVisible(tester, find.text('Zufälliges Passwort erzeugen'));
      expect(find.text('Passwort ersetzen?'), findsOneWidget);
      expect(
        tester.widget<TextFormField>(field('Passwort')).controller!.text,
        'keep-this-password',
      );
      await tester.tap(find.text('Behalten'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextFormField>(field('Passwort')).controller!.text,
        'keep-this-password',
      );
      await tapVisible(tester, find.text('Zufälliges Passwort erzeugen'));
      await tester.tap(find.text('Passwort ersetzen'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextFormField>(field('Passwort')).controller!.text,
        hasLength(24),
      );
      expect(
        find.text(
          'Ändere das Passwort auch bei der Website. Speichern allein ändert dein Konto nicht.',
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'empty vault provides explicit login, restore and desktop choices',
    (tester) async {
      final calls = <String>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        return switch (call.method) {
          'status' => {'available': true, 'secureDevice': true},
          'unlock' => <Object?>[],
          _ => null,
        };
      });
      final vault = VaultController();
      await tester.pumpWidget(HeavenKeyApp(controller: vault));
      await tester.tap(find.text('Tresor entsperren'));
      await tester.pumpAndSettle();
      expect(find.text('Dein Tresor ist leer'), findsOneWidget);
      expect(find.text('Ersten Login speichern'), findsOneWidget);
      expect(find.text('Sicherung wiederherstellen'), findsOneWidget);
      expect(find.text('Vom Desktop übernehmen'), findsOneWidget);
      expect(calls, isNot(contains('connectDesktop')));
      expect(calls, isNot(contains('restoreBackup')));
      await tapVisible(tester, find.text('Ersten Login speichern'));
      await tester.enterText(field('HTTPS-Website'), 'example.com');
      await tester.enterText(field('Passwort'), 'existing-test-password');
      await tapVisible(tester, find.text('Login speichern'));
      expect(find.text('Dein erster Login ist gespeichert'), findsOneWidget);
      await tapVisible(tester, find.text('Autofill einrichten').first);
      expect(find.text('Im Browser ausfüllen'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      vault.dispose();
    },
  );
}
