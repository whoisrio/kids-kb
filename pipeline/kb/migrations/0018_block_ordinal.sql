ALTER TABLE blocks ADD COLUMN ordinal INTEGER;

UPDATE blocks
SET ordinal = sub.rn
FROM (
    SELECT id, row_number() OVER (
        PARTITION BY page_id
        ORDER BY created_at, id
    ) AS rn
    FROM blocks
) AS sub
WHERE blocks.id = sub.id;

ALTER TABLE blocks ALTER COLUMN ordinal SET NOT NULL;
