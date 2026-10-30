package media

import (
	"context"
	"testing"
	"time"
)

func TestUnconfiguredR2SweepDoesNotCrash(t *testing.T) {
	var publisher *R2ImagePublisher
	// A typed nil inside an interface was the five-minute production crash.
	store := NewFileMediaStore()
	store.SetImagePublisher(publisher)
	store.sweepPublicImages()
	if err := publisher.Sweep(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}
}
