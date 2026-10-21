extends Node2D

## Moves right at a constant speed, so the project has one script for the workflow to parse.

@export var speed := 120.0


func _process(delta: float) -> void:
	position.x += speed * delta
