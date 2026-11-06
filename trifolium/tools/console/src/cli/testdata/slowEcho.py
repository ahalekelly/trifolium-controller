# A serial device on a pty for the tune CLI's port tests: prints the device's path, then echoes
# every write back 200 ms later, so each read has to wait on the port's poller.
import os
import pty
import time
import tty

leader, follower = pty.openpty()
tty.setraw(follower)
print(os.ttyname(follower), flush=True)
while True:
    data = os.read(leader, 4096)
    time.sleep(0.2)
    os.write(leader, data)
