CREATE TRIGGER operational_events_catalogue_controls_immutable_update
BEFORE UPDATE ON operational_events WHEN OLD.event_type='administrator_catalogue_change'
BEGIN SELECT RAISE(ABORT,'Administrator catalogue receipts are immutable'); END;
CREATE TRIGGER operational_events_catalogue_controls_immutable_delete
BEFORE DELETE ON operational_events WHEN OLD.event_type='administrator_catalogue_change'
BEGIN SELECT RAISE(ABORT,'Administrator catalogue receipts are retained'); END;
UPDATE application_metadata SET metadata_value='86',updated_at_ms=max(updated_at_ms,86)
WHERE metadata_key='data_model_version' AND metadata_value='85';
