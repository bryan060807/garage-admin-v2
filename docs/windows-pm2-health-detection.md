## Windows PM2 health detection

`PM2 online` is not sufficient to treat a Windows app as healthy in Garage Admin V2.

The service inventory now downgrades PM2 apps to `degraded` when the process looks unstable, including cases where:

- uptime is still near zero while restart count is already high
- restart count keeps rising between observations
- recent PM2 logs show `EADDRINUSE`
- the expected local port is being held by a PID that does not match the registered PM2 process

This avoids false healthy signals when an orphaned listener can still answer HTTP while the tracked PM2 app is flapping or failing.
