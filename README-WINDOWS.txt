GENIUS POS - WINDOWS QUICK START
========================================

Requirements
------------
Node.js LTS (one-time install): https://nodejs.org
Everything else is automatic.

How to run
----------
1. Double-click  start.bat
2. First run only: it downloads dependencies (needs internet, ~1 minute)
   and sets up an empty business - no demo data.
3. Your browser opens at  http://localhost:3000
4. The first time, the browser asks who you are:

       What is the business called?      e.g. Namuli Traders
       Your name                         e.g. Grace Namuli
       The name you will sign in with    e.g. grace
       Choose a password                 at least 8 characters

   There is no password to look up - you choose your own. That account is
   the owner and can do everything.

5. The setup wizard carries on from there: tax, what you sell, and logins
   for the rest of your staff. You can add more later under
   Settings > Users.

   After the first time it is an ordinary sign-in screen.


Keep the black window open while you work - that is the server.
Close it (or press Ctrl+C in it) to stop the app.

Forgotten your password?
------------------------
On the computer the app is installed on, open a command window in the
backend folder and run:

    node shared\firstrun.js --password

That resets the first account and prints the new password. To name one:

    node shared\firstrun.js --password grace
    node shared\firstrun.js --password grace "one you choose"

Nothing else is touched - not one sale, customer or item. It only works
at the machine itself, so it is not a way past the sign-in screen:
anyone who can run it can already read the database file.

Where is my data?
-----------------
Everything is stored in one file:  backend\data\genius.db
Back it up from inside the app:  Settings -> Backup -> Download backup.

Use it from other devices on your network
------------------------------------------
While the server is running on this PC, other devices on the same
Wi-Fi/LAN can open:   http://<this-pc-ip>:3000
(Find your IP with:  ipconfig  -> IPv4 Address.
 Allow Node.js through Windows Firewall when prompted.)

Change the port
---------------
Edit start.bat and add this line right before "node server.js":
    set PORT=8080

Troubleshooting
---------------
"node is not recognized"  -> Install Node.js, then reopen start.bat.
Port already in use       -> Another app uses 3000; set a different PORT.
Blank page                -> Wait 2-3 seconds after the window opens, refresh.
