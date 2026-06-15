// firebase-messaging-sw.js — registered automatically by firebase_messaging
// on web. Must live at the web/ root so it's served at
// /firebase-messaging-sw.js (the default Firebase Messaging SW scope).
// Background push notifications are handled by Firebase's default behavior;
// foreground notifications are redrawn by LocalNotificationsService in the
// Flutter app (see lib/services/push_messaging.dart).
//
// Config mirrors lib/firebase_options.dart `web` block — these are public
// client-side credentials. Keep in sync if firebase_options.dart changes.

importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyBqb0gnm8qPJxKchgFpZtYqtkD9K-7Xwjs',
  appId: '1:867004928263:web:ffe8e1f2f0a975439275a2',
  messagingSenderId: '867004928263',
  projectId: 'gitsync-645b3',
  authDomain: 'gitsync-645b3.firebaseapp.com',
  storageBucket: 'gitsync-645b3.firebasestorage.app',
});

firebase.messaging();
