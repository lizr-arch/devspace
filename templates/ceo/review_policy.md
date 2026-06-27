# Review Policy

## Review Process
1. Coach GPT receives local_report.md
2. Coach GPT reviews code changes, test results, and evidence
3. Coach GPT issues a verdict
4. Based on verdict, next action is determined

## Verdict Types

### PASS
- All acceptance criteria met
- No blocking issues
- Tests pass
- **Next Action**: Generate next_task.md or DONE

### PASS_WITH_WARNINGS
- Acceptance criteria met
- Minor issues exist but non-blocking
- Tests pass
- **Next Action**: Generate next_task.md with warnings noted

### NEEDS_FIX
- Some acceptance criteria not met
- Blocking issues exist
- Tests may fail
- **Next Action**: Generate fix task

### BLOCKED
- Cannot continue due to external factors
- Missing resources or dependencies
- **Next Action**: Generate blocked_report.md

### DONE
- All tasks completed
- Project goals achieved
- **Next Action**: Generate final_report.md

### NEED_USER
- User decision required
- High-risk choice needed
- **Next Action**: Generate user_question.md

### SAFETY_STOP
- Safety violation detected
- High-risk operation attempted
- **Next Action**: Stop immediately, generate safety_report.md

### BUDGET_STOP
- Budget limit reached
- Max rounds/failures/time exceeded
- **Next Action**: Stop and generate budget_report.md

## Review Evidence Checklist
Coach GPT must check:
- [ ] local_report.md
- [ ] test_report.md
- [ ] diff_summary.md
- [ ] diff.patch (if code changed)
- [ ] Acceptance criteria compliance
- [ ] Scope boundary compliance
