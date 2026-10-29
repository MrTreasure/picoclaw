package cron

import (
	"fmt"
	"time"

	"github.com/sipeed/picoclaw/pkg/cron"
)

func cronListCmd(storePath string) {
	cs := cron.NewCronService(storePath, nil)
	jobs := cs.ListJobs(true) // Show all jobs, including disabled

	if len(jobs) == 0 {
		fmt.Println("No scheduled jobs.")
		return
	}

	fmt.Println("\nScheduled Jobs:")
	fmt.Println("----------------")
	for _, job := range jobs {
		var schedule string
		if job.Schedule.Kind == "every" && job.Schedule.EveryMS != nil {
			schedule = fmt.Sprintf("every %ds", *job.Schedule.EveryMS/1000)
		} else if job.Schedule.Kind == "cron" {
			schedule = job.Schedule.Expr
		} else {
			schedule = "one-time"
		}

		nextRun := "scheduled"
		if job.State.NextRunAtMS != nil {
			nextTime := time.UnixMilli(*job.State.NextRunAtMS)
			nextRun = nextTime.Format("2006-01-02 15:04")
		}

		status := "enabled"
		if !job.Enabled {
			status = "disabled"
		}

		fmt.Printf("  %s (%s)\n", job.Name, job.ID)
		fmt.Printf("    Schedule: %s\n", schedule)
		fmt.Printf("    Status: %s\n", status)
		fmt.Printf("    Next run: %s\n", nextRun)
	}
}

func cronRemoveCmd(storePath, jobID string) error {
	if live, err := liveCronRequest(storePath, "DELETE", "/internal/cron/jobs/"+jobID, nil, nil); live {
		if err != nil {
			return err
		}
		fmt.Printf("✓ Removed job %s from running scheduler\n", jobID)
		return nil
	}

	cs := cron.NewCronService(storePath, nil)
	if cs.RemoveJob(jobID) {
		fmt.Printf("✓ Removed job %s\n", jobID)
	} else {
		fmt.Printf("✗ Job %s not found\n", jobID)
	}
	return nil
}

func cronSetJobEnabled(storePath, jobID string, enabled bool) error {
	if live, err := liveCronRequest(storePath, "PATCH", "/internal/cron/jobs/"+jobID, map[string]bool{"enabled": enabled}, nil); live {
		if err != nil {
			return err
		}
		fmt.Printf("✓ Job %s enabled=%t in running scheduler\n", jobID, enabled)
		return nil
	}

	cs := cron.NewCronService(storePath, nil)
	job := cs.EnableJob(jobID, enabled)
	if job != nil {
		fmt.Printf("✓ Job '%s' enabled\n", job.Name)
	} else {
		fmt.Printf("✗ Job %s not found\n", jobID)
	}
	return nil
}
