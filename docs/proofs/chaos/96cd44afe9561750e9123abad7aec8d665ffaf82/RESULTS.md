| Row                    | Class                   | Verdict        | Checks passed / failed |
| ---------------------- | ----------------------- | -------------- | ---------------------- |
| R-FE-REPLAY            | guaranteed              | PASS-candidate | 14 / 0                 |
| R-FE-CRASH-QUEUED      | guaranteed              | PASS-candidate | 6 / 0                  |
| R-FE-CRASH-UNSEEN      | guaranteed              | PASS-candidate | 6 / 0                  |
| R-FE-SHUTDOWN-DRAIN    | guaranteed              | FAIL           | 3 / 4                  |
| R-FE-REVOKE            | guaranteed              | PASS-candidate | 8 / 0                  |
| R-FE-KILL-MID-SEND     | ambiguous-external-send | FAIL           | 4 / 3                  |
| R-FE-DROP-AFTER-ACCEPT | ambiguous-external-send | FAIL           | 2 / 3                  |
